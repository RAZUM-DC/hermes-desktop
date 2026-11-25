/** One remote transaction shared by every Desktop SSH environment writer. */
export interface RemoteEnvUpdate {
  operation: "set";
  key: string;
  value: string;
}

export interface RemoteEnvUpdateResult {
  values: Record<string, string>;
  changed: boolean;
}

// The path and value travel as JSON on stdin. Credentials never appear in the
// SSH command line. The helper uses only Python's POSIX standard library.
export const REMOTE_ENV_UPDATE_SCRIPT = String.raw`
import fcntl
import json
import os
import re
import stat
import sys
import tempfile
import time


def copy_security_metadata(path, target_fd, previous):
    current = os.fstat(target_fd)
    if (current.st_uid, current.st_gid) != (previous.st_uid, previous.st_gid):
        os.fchown(target_fd, previous.st_uid, previous.st_gid)
    os.fchmod(target_fd, stat.S_IMODE(previous.st_mode))
    if getattr(previous, "st_flags", 0):
        raise OSError("Cannot safely replace a credential file with custom file flags")
    if sys.platform == "darwin":
        # Apple's fcopyfile(3): COPYFILE_ACL (1) | COPYFILE_XATTR (4).
        import ctypes
        library = ctypes.CDLL(None, use_errno=True)
        copy = library.fcopyfile
        copy.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
        copy.restype = ctypes.c_int
        with open(path, "rb") as source:
            if copy(source.fileno(), target_fd, None, 5) != 0:
                error = ctypes.get_errno()
                raise OSError(error, os.strerror(error))
    elif sys.platform.startswith("linux"):
        # Preserve POSIX ACLs, extended attributes and security labels.
        attributes = {name: os.getxattr(path, name) for name in os.listxattr(path)}
        for name in os.listxattr(target_fd):
            if name not in attributes:
                os.removexattr(target_fd, name)
        for name, value in attributes.items():
            os.setxattr(target_fd, name, value)
    else:
        raise OSError("Cannot preserve credential security metadata on this remote OS")


def update_env(payload):
    path = os.path.realpath(os.path.expanduser(payload["path"]))
    if payload.get("operation") != "set":
        raise ValueError("Unknown environment update")
    key, value = payload["key"], payload["value"]
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
        raise ValueError("Invalid environment variable name")
    if not isinstance(value, str) or any(c in value for c in "\r\n\0"):
        raise ValueError("Environment value contains illegal characters")

    directory = os.path.dirname(path)
    os.makedirs(directory, mode=0o700, exist_ok=True)
    # Keep a stable sibling lock. Locking .env would lock an obsolete inode
    # after the first atomic replacement.
    lock_fd = os.open(path + ".lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, "a") as lock:
        deadline = time.monotonic() + 10
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError("Timed out waiting for remote .env lock")
                time.sleep(0.05)

        previous = None
        try:
            with open(path, "r", encoding="utf-8", errors="surrogateescape", newline="") as source:
                previous = os.fstat(source.fileno())
                if not stat.S_ISREG(previous.st_mode):
                    raise ValueError("Remote .env is not a regular file")
                content = source.read()
        except FileNotFoundError:
            # Only a genuinely absent file may be provisioned from scratch.
            content = ""

        lines = content.splitlines(keepends=True)
        newline = "\r\n" if "\r\n" in content else "\n"
        updates = {key: value}
        output = []
        seen = set()
        for line in lines:
            match = re.match(r"^\s*(?:#\s*)?(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=", line)
            line_key = match[1] if match else None
            if line_key not in updates:
                output.append(line)
            elif line_key not in seen:
                ending = "\r\n" if line.endswith("\r\n") else "\n" if line.endswith("\n") else ""
                output.append(line_key + "=" + updates[line_key] + ending)
                seen.add(line_key)
        for update_key, update_value in updates.items():
            if update_key not in seen:
                if output and not output[-1].endswith(("\n", "\r")):
                    output[-1] += newline
                output.append(update_key + "=" + update_value + newline)

        updated = "".join(output)
        changed = updated != content
        if changed:
            fd, temporary = tempfile.mkstemp(prefix=".env-", suffix=".tmp", dir=directory)
            try:
                with os.fdopen(fd, "w", encoding="utf-8", errors="surrogateescape", newline="") as target:
                    # Apply the original access policy before writing secrets.
                    if previous is not None:
                        copy_security_metadata(path, target.fileno(), previous)
                    target.write(updated)
                    target.flush()
                    os.fsync(target.fileno())
                os.replace(temporary, path)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
        return {"values": updates, "changed": changed}


try:
    print(json.dumps(update_env(json.load(sys.stdin))))
except Exception as error:
    print("Could not safely update remote credentials: " + str(error), file=sys.stderr)
    sys.exit(1)
`;
