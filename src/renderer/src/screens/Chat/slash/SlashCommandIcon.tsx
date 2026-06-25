import React from "react";
import {
  Activity,
  Archive,
  ArrowUpCircle,
  Award,
  Bot,
  Brain,
  Bug,
  CheckCircle2,
  Code2,
  Coins,
  Columns,
  Compass,
  Eraser,
  FileText,
  Flame,
  Globe,
  HelpCircle,
  Image as ImageIcon,
  Info,
  LineChart,
  ListOrdered,
  MessageCircleQuestion,
  MessageSquarePlus,
  Mic,
  Minimize2,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Share2,
  Sparkles,
  Target,
  Terminal,
  Undo2,
  User,
  UserCheck,
  Video,
  Wrench,
  XCircle,
  Zap,
} from "lucide-react";

export const CUSTOM_SLASH_SVGS: Record<string, string | React.ReactNode> = {};

/**
 * Register a custom SVG string or React element for any slash command.
 */
export function registerCustomSlashSvg(
  name: string,
  svg: string | React.ReactNode,
): void {
  const clean = name.replace(/^\//, "").toLowerCase();
  CUSTOM_SLASH_SVGS[clean] = svg;
}

const ICON_MAP: Record<string, any> = {
  // Chat control
  new: MessageSquarePlus,
  clear: Eraser,

  // Agent commands
  btw: MessageCircleQuestion,
  bg: MessageCircleQuestion,
  background: MessageCircleQuestion,
  approve: CheckCircle2,
  deny: XCircle,
  status: Activity,
  reset: RotateCcw,
  compact: Minimize2,
  undo: Undo2,
  retry: RotateCw,
  fast: Zap,
  compress: Archive,
  usage: Coins,
  debug: Bug,
  goal: Target,
  steer: Compass,
  queue: ListOrdered,
  update: ArrowUpCircle,

  // Tools
  web: Globe,
  image: ImageIcon,
  browse: Compass,
  code: Code2,
  file: FileText,
  shell: Terminal,

  // Info
  help: HelpCircle,
  tools: Wrench,
  skills: Sparkles,
  "reload-skills": RefreshCw,
  kanban: Columns,
  curator: Award,
  model: Bot,
  memory: Brain,
  persona: UserCheck,
  version: Info,

  // Skills & Agent built-ins
  voice: Mic,
  "weights-and-biases": LineChart,
  whoami: User,
  xurl: Share2,
  yolo: Flame,
  "youtube-content": Video,
  yuanbao: Bot,
};

const CATEGORY_DEFAULTS: Record<string, any> = {
  chat: MessageSquarePlus,
  agent: Bot,
  tools: Wrench,
  info: Info,
};

export interface SlashCommandIconProps {
  name: string;
  category?: string;
  className?: string;
  size?: number;
}

// @lat: [[chat-commands#Slash command execution#Central command router]]
export function SlashCommandIcon({
  name,
  category,
  className = "",
  size = 14,
}: SlashCommandIconProps): React.JSX.Element {
  const cleanName = name.replace(/^\//, "").toLowerCase();

  // 1. Custom SVG override
  const custom = CUSTOM_SLASH_SVGS[cleanName];
  if (custom) {
    if (typeof custom === "string") {
      return (
        <span
          className={`slash-icon-custom ${className}`}
          style={{ width: size, height: size, display: "inline-flex" }}
          dangerouslySetInnerHTML={{ __html: custom }}
        />
      );
    }
    return <span className={`slash-icon-custom ${className}`}>{custom}</span>;
  }

  // 2. Exact Lucide map
  const IconComponent: any =
    ICON_MAP[cleanName] ??
    (category ? CATEGORY_DEFAULTS[category.toLowerCase()] : undefined) ??
    Sparkles;

  return <IconComponent size={size} className={className} />;
}
