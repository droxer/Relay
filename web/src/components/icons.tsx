// Curated icon set for the Relay web UI. Wraps lucide-react so every glyph
// in the app shares one stroke width and we have one place to swap
// semantics later.

import {
  ArrowLeft,
  ArrowRightLeft,
  ArrowUp,
  ArrowUpRight,
  BookOpen,
  Bot,
  Building2,
  Check,
  CircleAlert,
  CircleCheck,
  CircleStop,
  Coins,
  Copy,
  CalendarDays,
  Cloud,
  Columns3,
  CircleDashed,
  File,
  FileDiff,
  FileText,
  FolderClosed,
  Rows3,
  Forward,
  Hash,
  Inbox,
  ImagePlus,
  Play,
  Info,
  KeyRound,
  Languages,
  Laptop,
  LayoutDashboard,
  LayoutGrid,
  Layers,
  Link2,
  ListChecks,
  LockKeyhole,
  Palette,
  LogOut,
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  Paperclip,
  Pencil,
  Minus,
  ArrowLeftRight,
  CornerDownRight,
  EllipsisVertical,
  FolderPlus,
  GripVertical,
  ListFilter,
  ListFilterPlus,
  LoaderCircle,
  RotateCw,
  SlidersHorizontal,
  Ungroup,
  Plus,
  Power,
  RefreshCw,
  Repeat,
  RotateCcw,
  ScanEye,
  Search,
  Settings,
  Square,
  Star,
  Settings2,
  ShieldCheck,
  SquarePen,
  Terminal,
  Trash2,
  UserRound,
  Users,
  WifiOff,
  TriangleAlert,
  UserPlus,
  X,
  Check as LucideCheck,
  ChevronDown as LucideChevronDown,
  ChevronLeft as LucideChevronLeft,
  ChevronRight as LucideChevronRight,
  ChevronsUpDown,
  ChevronUp as LucideChevronUp,
  X as LucideX,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";
import { forwardRef } from "react";

import { IdentityMark } from "./IdentityMark";
import { ChipGlyph, TaskListGlyph, type RelayGlyphProps } from "./navGlyphs";

// Standard refined stroke for every icon in the product. Lucide defaults to
// 2 which feels chunky next to the rest of the type; 1.75 reads as
// engineering-precise without losing legibility at 13–18 px.
/**
 * The prop surface a glyph accepts. Re-exported here so a caller that needs to
 * type an icon slot does not have to import from lucide-react to do it — the
 * module's "only place allowed to import lucide" rule covers the type as well
 * as the pictures, or the import creeps back in one `type` keyword at a time.
 */
export type GlyphProps = Pick<LucideProps, "size" | "className">;

export const ICON_STROKE = 1.75;

// Large decorative strokes thin out as size grows so big glyphs (empty-state
// illustrations, ~40px+) read at the same optical weight as the 1.75 chrome
// icons instead of looking bloated. One shared value so future large icons
// don't each pick their own number.
export const ICON_STROKE_LARGE = 1.25;

/**
 * Glyph sizes. The one scale for anything drawn as a square picture: lucide
 * icons, vendor AgentMarks, IdentityMarks, the Relay mark.
 *
 * This module already insisted on being the single source for WHICH glyph and
 * for its stroke — "one shared value so future large icons don't each pick
 * their own number" is the note on ICON_STROKE_LARGE, three lines up. Size was
 * the one property left to the call site, and it went exactly where you would
 * expect: 183 hardcoded numbers across eleven distinct values, including 24
 * uses of a bare 13 and 12 of a bare 15 — a pixel off the neighbouring rung in
 * each direction, with nothing to say why. The CSS half of the app has
 * tokenised colour, spacing, radii, type, and motion; this was the last
 * dimension still being eyeballed.
 *
 * Rungs are sized against the TYPE they sit beside, which is what makes a
 * glyph look right or wrong next to a label:
 *
 *   xs  12  inside a badge or pill, beside --type-micro
 *   sm  14  the default — chrome icons beside a --type-body-sm label
 *   md  16  a standalone control glyph with no adjacent label (icon buttons,
 *           composer actions), and vendor marks in a chip
 *   lg  18  section- and nav-level glyphs, beside --type-heading
 *   xl  24  a glyph that is the subject rather than a label's companion
 *   hero 40 empty-state illustrations; pair with ICON_STROKE_LARGE so the
 *           optical weight matches the chrome tiers
 *
 * Reach for `ICON.sm` by default. If a glyph looks wrong at every rung, the
 * problem is usually the type beside it, not the scale.
 */
export const ICON = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 18,
  xl: 24,
  hero: 40,
} as const;

/**
 * Avatar box sizes — a different question from ICON above. An avatar is a
 * container that holds a glyph, initials, or a photograph and carries its own
 * presence pip; a glyph is the picture inside. They ran together at 24, 28,
 * 32, 36, 40 and 56px, so the two questions are separated here and answered
 * once each.
 *
 *   sm  24  inline with a line of text
 *   md  32  a list row's identity slot
 *   lg  40  a card header
 *   xl  56  an empty state or a page hero
 */
export const AVATAR = {
  sm: 24,
  md: 32,
  lg: 40,
  xl: 56,
} as const;

/* Accepts a lucide icon or one of Relay's own glyphs from `navGlyphs` — they
   publish the same call shape on purpose, so the stroke contract is applied
   once for both and a bespoke glyph cannot drift off the shared weight. */
type StrokedGlyph = LucideIcon | typeof TaskListGlyph;

function withStandardStroke(Icon: StrokedGlyph, displayName: string) {
  const Wrapped = forwardRef<SVGSVGElement, LucideProps & RelayGlyphProps>((props, ref) => (
    <Icon ref={ref} strokeWidth={ICON_STROKE} aria-hidden="true" {...props} />
  ));
  Wrapped.displayName = displayName;
  return Wrapped;
}

/**
 * A nav/section glyph that draws the very mark the class already owns.
 *
 * `NavAgents` was a lucide robot head and `NavTeams` a lucide network node,
 * while every profile slot in the app drew the agent node and the team cluster
 * from `IdentityMark`. That is two pictures for one class: the rail said one
 * thing about an agent and the row beside it said another. The section glyph
 * is the same silhouette as the thing the section contains, so a reader
 * learns each shape once.
 *
 * It draws the OUTLINE variant, not the filled one the profile chips use.
 * Two solid marks in a rail of eleven hairline lucide siblings were the only
 * heavy ink in the column, and heavy ink is precisely how the rail paints a
 * selected row — so Agents and Teams read as permanently active. Hairline at
 * the shared `ICON_STROKE` puts them on one weight with their neighbours and
 * gives the active state somewhere to go. (The filled `bare` variant also
 * pinned itself to `--ink-2` through `.identity-mark`, so these two glyphs
 * were additionally the only ones in the rail that did not brighten when
 * their row was selected; the outline variant inherits row ink.)
 */
function identityGlyph(kind: "agent" | "team", displayName: string) {
  function Glyph({ size = ICON.sm, className }: Pick<LucideProps, "size" | "className">) {
    return (
      <IdentityMark
        kind={kind}
        variant="outline"
        size={Number(size)}
        strokeWidth={ICON_STROKE}
        className={className}
      />
    );
  }
  Glyph.displayName = displayName;
  return Glyph;
}

// Semantic exports. Anywhere we want to swap the underlying glyph, do it
// here — no caller in the app has to know which lucide picture we chose.
// This module is the only place allowed to import lucide-react: a glyph
// reached for directly ships lucide's default stroke (2) next to our 1.75
// chrome, and a second component can then pick a different picture for a
// meaning that already has one.
// One bubble, not lucide's stacked pair. `MessagesSquare` draws a second
// bubble offset behind the first, and at the rail's 18px the offset is ~2px:
// the two outlines converge into a thick smudge along one corner and the
// glyph reads as a blot rather than a bubble. Plurality is the label's job.
export const NavThreads = withStandardStroke(MessageSquare, "NavThreads");
// The org console, not a user's settings. `UserCog` put a SECOND gear in the
// rail — directly above Preferences' `Settings` gear in the footer — and
// framed the whole admin surface as "edit a person", when what it actually
// holds is employees, departments, org settings and the fleet. A building is
// the organisation those belong to, and no other glyph in the app claims it.
//
// The obvious objection is that the rail LABELS this "Control panel", and a
// slider bank matches those words better than a building does. Tested, and
// the answer is no — twice over:
//   - `SlidersHorizontal` is three horizontal rules with one of them marked,
//     which is `NavBacklog` (see navGlyphs.tsx) at 18px. Rendered side by
//     side in the rail column they are the same glyph. Hard collision.
//   - `Settings2` is the same shape again AND is already `AdminManageExecutors`.
//   - `SlidersVertical` genuinely clears both — vertical faders collide with
//     nothing here — but it describes tweaking knobs, and this destination
//     holds employees, departments and a fleet of machines. Building2 names
//     what the page CONTAINS; faders name what you imagine doing there.
// If this pairing is ever revisited, the weaker half is the label, not the
// glyph — renaming the destination is a product call, not an icon one.
export const NavAdmin = withStandardStroke(Building2, "NavAdmin");
// Drawn in-house — see `navGlyphs.tsx` for why no lucide task list survives
// the rail at 18px.
export const NavBacklog = withStandardStroke(TaskListGlyph, "NavBacklog");
// A project, as distinct from a directory. The rail used to render projects
// with `WorkspaceFolder` — literally the same component the file tree draws
// beside every folder row — so "the Projects destination" and "a folder on
// disk" were one picture. A project HAS a workspace; it is not one.
//
// `FolderKanban` fixed the meaning and lost it again on form: a folder with
// three bars inside is the busiest silhouette available for the calmest idea,
// and it still opened with a folder. The stack keeps the "a body of related
// work" reading, and — the deciding constraint — it is the only glyph in the
// rail with a horizontal-stack outline, where the boxed alternatives all
// collided with Threads, Computer and Control panel.
export const NavProjects = withStandardStroke(Layers, "NavProjects");
export const NavChannels = withStandardStroke(Hash, "NavChannels");
// Recurrence, not a point in time. `CalendarClock` says "something is
// scheduled"; a routine's whole content is that it happens AGAIN. The loop
// also survives `RoutineOriginBadge`, which draws this same glyph at 14px,
// where a calendar grid plus an overlaid clock face closes up into hatching.
export const NavRoutine = withStandardStroke(Repeat, "NavRoutine");
export const NavAgents = identityGlyph("agent", "NavAgents");
// A team is a cluster of agent nodes — no longer *the same idea
// as* the bespoke team IdentityMark, but that mark itself. `Users` stays with
// employees (actual people), so the roster chip and the teams nav are not the
// same silhouette.
export const NavTeams = identityGlyph("team", "NavTeams");
// The skills section: a reference manual, not a tool or a document. SideNav
// reached for lucide's BookOpen directly, so the one nav item in the rail that
// bypassed this module also shipped lucide's default stroke 2 beside eleven
// siblings drawn at 1.75 — the rail's only visibly heavier glyph.
export const NavSkills = withStandardStroke(BookOpen, "NavSkills");
export const NavPreferences = withStandardStroke(Settings, "NavPreferences");
export const NavLogout = withStandardStroke(LogOut, "NavLogout");
export const NavRefresh = withStandardStroke(RefreshCw, "NavRefresh");
export const NavSidebarCollapse = withStandardStroke(PanelLeftClose, "NavSidebarCollapse");
export const NavSidebarExpand = withStandardStroke(PanelLeftOpen, "NavSidebarExpand");
export const NavMore = withStandardStroke(MoreHorizontal, "NavMore");
// The computers section is a machine, not a data-centre rack, and not a
// screen either: every computer *inside* it is drawn by its ownership glyph
// (a cloud or a laptop, below), so `Monitor` and `Laptop` would collapse the
// section into one of its own members. `Cpu` said the right thing and was
// kept through two passes for it, but it was the densest mark in the rail;
// `ChipGlyph` is the same noun at two pins instead of eight.
export const NavComputer = withStandardStroke(ChipGlyph, "NavComputer");
// Compose a new thread (pencil-in-square), the messaging-app convention.
export const ActionCompose = withStandardStroke(SquarePen, "ActionCompose");

export const ActionCopy = withStandardStroke(Copy, "ActionCopy");
export const ActionRetry = withStandardStroke(RefreshCw, "ActionRetry");
export const ActionSend = withStandardStroke(ArrowUp, "ActionSend");
// Starter-prompt chip affordance — the arrow reads as "drop this into the
// composer" without reusing the send glyph's meaning.
export const ActionPrompt = withStandardStroke(ArrowUpRight, "ActionPrompt");
export const ActionApprove = withStandardStroke(Check, "ActionApprove");
export const ActionHandoff = withStandardStroke(Forward, "ActionHandoff");
// Routing a turn to another agent — the two-way arrows read as "pass along",
// matching the transcript handoff phase divider.
export const ActionRoute = withStandardStroke(ArrowRightLeft, "ActionRoute");
export const ActionStart = withStandardStroke(Play, "ActionStart");
export const ActionStop = withStandardStroke(CircleStop, "ActionStop");
// Composer stop glyph — a solid square reads as "stop" instantly at small
// sizes, where the outline circle-stop collapses into a fuzzy ring. Solid
// fill, no stroke, so it sits cleanly on the filled plate.
export const ComposerStop = forwardRef<SVGSVGElement, LucideProps>((props, ref) => (
  <Square ref={ref} fill="currentColor" stroke="none" strokeWidth={0} aria-hidden="true" {...props} />
));
ComposerStop.displayName = "ComposerStop";
export const ActionAddPerson = withStandardStroke(UserPlus, "ActionAddPerson");
export const ActionRemove = withStandardStroke(X, "ActionRemove");
export const NavBack = withStandardStroke(ArrowLeft, "NavBack");
export const ActionSearch = withStandardStroke(Search, "ActionSearch");
export const ActionCalendar = withStandardStroke(CalendarDays, "ActionCalendar");
// A file is a blank sheet wherever it appears — the workspace tree and the
// artifact strip must not picture the same object two ways. `FileText`
// (ruled lines) is reserved for written prose, i.e. the summary artifact.
export const WorkspaceFile = withStandardStroke(File, "WorkspaceFile");
export const WorkspaceFolder = withStandardStroke(FolderClosed, "WorkspaceFolder");
export const ViewBoard = withStandardStroke(Columns3, "ViewBoard");
export const ViewList = withStandardStroke(Rows3, "ViewList");
export const ViewGrid = withStandardStroke(LayoutGrid, "ViewGrid");
export const ActionKey = withStandardStroke(KeyRound, "ActionKey");
export const ActionImage = withStandardStroke(ImagePlus, "ActionImage");

// Computer ownership glyphs. These answer "whose machine is this?", not "how
// does the daemon sandbox a run?" — sandbox mode stays a text-only badge. A
// cloud computer Relay provisions is a cloud; a local computer is a person's
// own machine (a laptop, the shape everyone reads as "my computer"); pending
// ownership is an unresolved ring. The earlier container/terminal pair
// pictured the runtime instead and read as "box" and "shell".
export const NodeManaged = withStandardStroke(Cloud, "NodeManaged");
export const NodeLocal = withStandardStroke(Laptop, "NodeLocal");
export const NodePending = withStandardStroke(CircleDashed, "NodePending");

/** The one map from ownership to glyph. Two call sites — the placement badge
 *  and the node profile badges — each kept a private copy of this record, so
 *  a fourth ownership kind (or a different picture for an existing one) would
 *  have had to be remembered twice. */
export type NodeOwnership = "managed" | "local" | "pending";

const NODE_OWNERSHIP_ICON: Record<NodeOwnership, typeof NodeManaged> = {
  managed: NodeManaged,
  local: NodeLocal,
  pending: NodePending,
};

/** The card/row avatar is a computer's logo, so it carries the ownership
 *  glyph rather than one generic machine for every computer. */
export function nodeOwnershipIcon(ownership: NodeOwnership): typeof NodeManaged {
  return NODE_OWNERSHIP_ICON[ownership];
}

// Preferences category glyphs.
export const PrefAppearance = withStandardStroke(Palette, "PrefAppearance");
export const PrefLanguage = withStandardStroke(Languages, "PrefLanguage");

// Outcome markers, shared by every surface that reports one (stream status
// lines, destructive dialogs). A deliberate geometric family: circle /
// circle / triangle / circle for info / ok / warn / error, so severity is
// carried by the enclosing shape and not by colour alone.
export const StatusOk = withStandardStroke(CircleCheck, "StatusOk");
export const StatusInfo = withStandardStroke(Info, "StatusInfo");
export const StatusWarn = withStandardStroke(TriangleAlert, "StatusWarn");
export const StatusError = withStandardStroke(CircleAlert, "StatusError");
// Presence, not ownership. This lived in the ownership block above and
// answered a different question there: a computer is a cloud or a laptop
// whether or not it is reachable right now.
export const NodeOffline = withStandardStroke(WifiOff, "NodeOffline");
export const StreamAttachment = withStandardStroke(Paperclip, "StreamAttachment");

// The thread space toggle shows and hides the right-hand panel; it is a
// panel control, not an attachment. A paperclip pictured "something clipped
// to this message" — the wrong object, since the panel holds what the thread
// *produced*. `PanelRight` joins the existing PanelLeft* sidebar pair so
// every chrome control that reveals a panel is drawn the same way, and the
// filled edge points at the side the panel appears on.
export const ThreadSpaceToggle = withStandardStroke(PanelRight, "ThreadSpaceToggle");

// The team/project lead. A star marks one member of a roster as first among
// equals without spending a word on it — a crown would read as ownership of
// the people rather than of the work, and the roster already spends its
// horizontal room on the role pill.
export const MarkLead = withStandardStroke(Star, "MarkLead");

// Identity and metrics inside a transcript.
export const IdentityUser = withStandardStroke(UserRound, "IdentityUser");
export const MetricTokens = withStandardStroke(Coins, "MetricTokens");

// Artifact library glyphs. The artifact strip is a kind *filter*, so every
// kind needs its own picture: diff, summary and workspace file used to share
// one FileText, collapsing three of the eight kinds into one silhouette. The
// three paper-shaped kinds now separate by their mark — plus/minus for a
// diff, ruled lines for written prose, blank sheet for a produced file.
// A checklist an agent produced, NOT the backlog. This drew `ListTodo` — the
// very picture `NavBacklog` uses — so one silhouette stood for both "the
// workspace's task queue" and "this run's plan". `ListChecks` keeps the
// list-of-tasks reading and leaves the checkbox-list shape to the rail.
export const ArtifactPlan = withStandardStroke(ListChecks, "ArtifactPlan");
export const ArtifactDiff = withStandardStroke(FileDiff, "ArtifactDiff");
export const ArtifactReview = withStandardStroke(ScanEye, "ArtifactReview");
export const ArtifactTest = withStandardStroke(CircleCheck, "ArtifactTest");
export const ArtifactCommand = withStandardStroke(Terminal, "ArtifactCommand");
export const ArtifactSummary = withStandardStroke(FileText, "ArtifactSummary");
export const ArtifactOutput = withStandardStroke(Bot, "ArtifactOutput");
export const ArtifactFile = withStandardStroke(File, "ArtifactFile");

// shadcn primitives (sheet, select) reach for these by their original
// names; wrap them so they share ICON_STROKE with the rest of the app.
export const CheckIcon = withStandardStroke(LucideCheck, "CheckIcon");
export const ChevronDownIcon = withStandardStroke(LucideChevronDown, "ChevronDownIcon");
export const ChevronUpIcon = withStandardStroke(LucideChevronUp, "ChevronUpIcon");
export const XIcon = withStandardStroke(LucideX, "XIcon");

// Column-header sort affordance. Three states, one glyph slot: the active
// column shows the direction it is sorted in, every other sortable column
// shows the neutral double caret so the header advertises that it CAN sort
// without four competing arrows fighting the column labels for attention.
export const SortAscending = withStandardStroke(LucideChevronUp, "SortAscending");
export const SortDescending = withStandardStroke(LucideChevronDown, "SortDescending");
export const SortInactive = withStandardStroke(ChevronsUpDown, "SortInactive");

// Disclosure affordance for a collapsible block (the transcript's reasoning
// header). It points at the closed state and the component rotates it open, so
// one glyph covers both states and the rotation carries the transition.
export const DisclosureChevron = withStandardStroke(LucideChevronRight, "DisclosureChevron");

// Pager steps. Same chevron family as the sort carets, one axis over.
export const PagePrevious = withStandardStroke(LucideChevronLeft, "PagePrevious");
export const PageNext = withStandardStroke(LucideChevronRight, "PageNext");

// Generic actions not covered above.
export const ActionAdd = withStandardStroke(Plus, "ActionAdd");
export const ActionSubtract = withStandardStroke(Minus, "ActionSubtract");
export const ActionEdit = withStandardStroke(Pencil, "ActionEdit");
export const ActionToggle = withStandardStroke(Power, "ActionToggle");

// Admin page glyphs — node/employee management and channel setup.
// Same machine as NavComputer — the admin fleet section and the computers
// nav are one object seen from two surfaces.
export const AdminNode = withStandardStroke(ChipGlyph, "AdminNode");
export const AdminManageExecutors = withStandardStroke(Settings2, "AdminManageExecutors");
export const AdminDelete = withStandardStroke(Trash2, "AdminDelete");
export const AdminRestore = withStandardStroke(RotateCcw, "AdminRestore");
export const AdminDashboard = withStandardStroke(LayoutDashboard, "AdminDashboard");
export const AdminEmployees = withStandardStroke(Users, "AdminEmployees");
export const AdminConnect = withStandardStroke(Link2, "AdminConnect");
export const AdminLocked = withStandardStroke(LockKeyhole, "AdminLocked");
// Same glyph as NavChannels — admin channel setup and the channels nav are
// the same object seen from two surfaces.
export const AdminChannel = withStandardStroke(Hash, "AdminChannel");
export const AdminVerified = withStandardStroke(ShieldCheck, "AdminVerified");
export const AdminInbox = withStandardStroke(Inbox, "AdminInbox");
export const AdminSettings = withStandardStroke(Settings, "AdminSettings");

// ReUI component glyphs. The vendored ReUI components (components/reui/)
// name their icons by lucide name through `IconPlaceholder`
// (components/reui/icon-placeholder.tsx); this table is where each name gets
// the product's stroke, so a vendored component cannot draw an off-weight glyph.
export const REUI_GLYPHS = {
  ArrowLeftRightIcon: withStandardStroke(ArrowLeftRight, "ReuiArrowLeftRight"),
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon: PagePrevious,
  ChevronRightIcon: PageNext,
  CircleAlertIcon: withStandardStroke(CircleAlert, "ReuiCircleAlert"),
  CopyIcon: ActionCopy,
  CornerDownRightIcon: withStandardStroke(CornerDownRight, "ReuiCornerDownRight"),
  EllipsisVerticalIcon: withStandardStroke(EllipsisVertical, "ReuiEllipsisVertical"),
  FolderPlusIcon: withStandardStroke(FolderPlus, "ReuiFolderPlus"),
  GripVerticalIcon: withStandardStroke(GripVertical, "ReuiGripVertical"),
  LayersIcon: withStandardStroke(Layers, "ReuiLayers"),
  ListFilterIcon: withStandardStroke(ListFilter, "ReuiListFilter"),
  ListFilterPlusIcon: withStandardStroke(ListFilterPlus, "ReuiListFilterPlus"),
  LoaderCircleIcon: withStandardStroke(LoaderCircle, "ReuiLoaderCircle"),
  MinusIcon: ActionSubtract,
  PlusIcon: ActionAdd,
  RefreshCwIcon: withStandardStroke(RefreshCw, "ReuiRefreshCw"),
  RotateCwIcon: withStandardStroke(RotateCw, "ReuiRotateCw"),
  SlidersHorizontalIcon: withStandardStroke(SlidersHorizontal, "ReuiSlidersHorizontal"),
  UngroupIcon: withStandardStroke(Ungroup, "ReuiUngroup"),
  XIcon: ActionRemove,
} as const;
