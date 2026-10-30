import {
  ArrowDownAZ,
  Binary,
  Bot,
  CalendarMinus,
  CalendarPlus,
  Clipboard,
  Clock,
  Cloud,
  CloudOff,
  CloudUpload,
  Copy,
  Scissors,
  ClipboardPaste,
  Download,
  ExternalLink,
  Eye,
  FileArchive,
  FileJson,
  FilePlus,
  FileSearch,
  FileText,
  Filter,
  FolderInput,
  FolderPlus,
  Image,
  ImagePlus,
  Replace,
  Lock,
  Pencil,
  PanelLeft,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Tags,
  Trash2,
  Unlock,
  Upload,
  UserCog,
  Variable,
  X
} from 'lucide-react';

/**
 * The one place that decides which icon stands for which menu action, so
 * "Duplicate" looks the same in the Documents sidebar, the Kanban board list
 * and the workflow context menu. Every context menu and action dropdown in
 * the app draws from this map (through MenuItemIcon, or by passing one of
 * these to ContextMenuItem / HamburgerMenuItem / CategorySubmenu).
 *
 * Conventions:
 *   - "New X" is Plus, except a new document (FilePlus), a new category
 *     (FolderPlus) and a new calendar entry (CalendarPlus).
 *   - Exports are named by format: JSON (FileJson), Base64 (Binary),
 *     ZIP (FileArchive), PDF (FileText); an export whose label names no
 *     format is a plain Download, and every import is an Upload.
 *   - The cloud trio is the same on Documents, Kanban, Tasks and Workflows:
 *     Share with the Team (CloudUpload), Sync Changes (RefreshCw), Stop
 *     Sharing (CloudOff); the keys keep their cloud names.
 *   - All "Close ... tab(s)" entries use X, as the tab menus always did.
 */
export const MENU_ICONS = {
  new: Plus,
  newDocument: FilePlus,
  newCategory: FolderPlus,
  newCalendarEntry: CalendarPlus,
  edit: Pencil,
  rename: Pencil,
  duplicate: Copy,
  delete: Trash2,
  export: Download,
  exportJson: FileJson,
  exportBase64: Binary,
  exportZip: FileArchive,
  exportPdf: FileText,
  import: Upload,
  download: Download,
  moveToCategory: FolderInput,
  managePermissions: UserCog,
  uploadToCloud: CloudUpload,
  syncToCloud: RefreshCw,
  removeFromCloud: CloudOff,
  closeTab: X,
  openInNewWindow: ExternalLink,
  openLeft: PanelLeft,
  openRight: PanelRight,
  copyText: Clipboard,
  // the editor's clipboard items (the shared context menu's Cut / Copy / Paste)
  cut: Scissors,
  copy: Copy,
  paste: ClipboardPaste,
  sortByDate: Clock,
  sortByTitle: ArrowDownAZ,
  sortByCloud: Cloud,
  preview: Eye,
  lock: Lock,
  unlock: Unlock,
  aiContext: Bot,
  findInFiles: FileSearch,
  searchIn: Search,
  applyFilter: Filter,
  editTags: Tags,
  insert: ImagePlus,
  replaceImage: Replace,
  removeFromList: CalendarMinus,
  hideSidebar: PanelLeftClose,
  showSidebar: PanelLeftOpen,
  variables: Variable,
  mediaLibrary: Image,
  settings: Settings
};
