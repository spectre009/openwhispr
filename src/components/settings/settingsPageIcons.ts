import type React from "react";
import {
  AudioLines,
  Blocks,
  BookOpen,
  ClipboardCheck,
  CreditCard,
  FileAudio,
  FileText,
  FolderOpen,
  FolderRounded,
  Gauge,
  HardDrive,
  Key,
  KeyRound,
  Keyboard,
  Languages,
  LocateFixed,
  MessageCircle,
  MessageSquare,
  Mic,
  Mic2,
  Network,
  NotebookPen,
  Pencil,
  Play,
  Settings,
  Shield,
  Sliders,
  Sparkles,
  SquareSparkle,
  Sun,
  Upload,
  UserCircle,
  Users,
  Wand2,
  Wrench,
} from "../icons";
import {
  SETTINGS_NAV,
  SETTINGS_PAGES,
  type SettingsIconName,
  type SettingsPageId,
  type SettingsParentId,
} from "./settingsPages";

type IconComponent = React.ComponentType<{ className?: string }>;

const ICONS: Record<SettingsIconName, IconComponent> = {
  AudioLines,
  Blocks,
  BookOpen,
  ClipboardCheck,
  CreditCard,
  FileAudio,
  FileText,
  FolderOpen,
  FolderRounded,
  Gauge,
  HardDrive,
  Key,
  KeyRound,
  Keyboard,
  Languages,
  LocateFixed,
  MessageCircle,
  MessageSquare,
  Mic,
  Mic2,
  Network,
  NotebookPen,
  Pencil,
  Play,
  Settings,
  Shield,
  Sliders,
  Sparkles,
  SquareSparkle,
  Sun,
  Upload,
  UserCircle,
  Users,
  Wand2,
  Wrench,
};

export function settingsIcon(name: SettingsIconName): IconComponent {
  return ICONS[name];
}

const PARENT_ICONS = new Map<string, SettingsIconName>();
for (const group of SETTINGS_NAV) {
  for (const item of group.items) if (item.kind === "parent") PARENT_ICONS.set(item.id, item.icon);
}

/** The icon of a page or a parent (search results show their page's). */
export function settingsPageIcon(
  id: SettingsPageId | SettingsParentId | string
): IconComponent | undefined {
  const page = SETTINGS_PAGES[id as SettingsPageId];
  if (page) return ICONS[page.icon];
  const parent = PARENT_ICONS.get(id);
  return parent ? ICONS[parent] : undefined;
}
