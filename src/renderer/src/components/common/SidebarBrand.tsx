import razumWordmark from "../../assets/hermes-one.svg";

/** RAZUM wordmark rendered as an image so a failed CSS mask cannot become a rectangle. */
export default function SidebarBrand(): React.JSX.Element {
  return (
    <img
      className="sidebar-logo"
      src={razumWordmark}
      alt="RAZUM"
      draggable={false}
    />
  );
}
