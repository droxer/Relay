"use client";

import { useState, type ReactNode } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { Card, CardHeader, CardTitle, CardDescription, CardAction, CardContent, CardFooter } from "@/components/ui/card";
import { Drawer } from "@/components/ui/Drawer";
import { useDialogs } from "@/components/ui/DialogProvider";
import { toast } from "@/components/ui/toast";
import { RoutineStateBadge } from "@/components/RoutineStateBadge";
import { Label } from "@/components/ui/label";
import { Field, FieldError } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem, RadioGroupChoice } from "@/components/ui/radio-group";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip } from "@/components/ui/tooltip";
import { Pagination } from "@/components/ui/Pagination";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SearchInput } from "@/components/ui/search-input";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import { StatusPill } from "@/components/StatusPill";
import { paginate } from "@/lib/pagination";
import { ActionRemove, ICON, NavPreferences } from "@/components/icons";

/* The design-system specimen: every ui/ primitive, rendered with no API calls
   and no persisted example records.
 *
 * `npm run test:design` drives THIS page, so a variant that does not appear
 * here has no visual-regression net. That is the rule the file is organised
 * around: the Button matrix below is exhaustive on purpose — six variants and
 * eleven sizes are the app's whole control vocabulary, and four of those
 * combinations used to be the only ones any test had ever rendered.
 *
 * Accessible names are the test surface. `e2e/design-consistency.spec.ts`
 * finds controls by role + name ("Page select", "Example switch", "Small
 * button"), so renaming one here breaks a test that is not in this file.
 */

function ExampleSelect({ label, size = "default" }: { label: string; size?: "default" | "sm" }) {
  return <Select defaultValue="one" items={[{ value: "one", label: "First option" }, { value: "two", label: "Second option" }]}><SelectTrigger aria-label={label} size={size}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="one">First option</SelectItem><SelectItem value="two">Second option</SelectItem></SelectContent></Select>;
}

function OverlayFields() {
  return <div className="flex flex-col gap-4">
    <Input aria-label="Overlay input" />
    <Input aria-label="Invalid overlay input" aria-invalid="true" />
    <Textarea aria-label="Overlay notes" />
    <ExampleSelect label="Overlay select" />
  </div>;
}

/** A titled block. Plain markup — the specimen must not depend on a surface
 *  stylesheet, or it would stop being a test of the primitives alone. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="flex flex-col gap-3">
    <h2 className="m-0 text-md font-bold text-ink">{title}</h2>
    <Card padding="compact"><div className="flex flex-wrap items-center gap-3">{children}</div></Card>
  </section>;
}

const BUTTON_VARIANTS = ["default", "outline", "secondary", "ghost", "destructive", "icon"] as const;
const BUTTON_SIZES = ["xs", "dense", "sm", "default", "lg", "cta"] as const;
const ICON_SIZES = ["icon-xs", "icon-dense", "icon-sm", "icon", "icon-lg"] as const;

export function DesignSystemSpecimen() {
  const [drawer, setDrawer] = useState(false);
  const [tab, setTab] = useState("first");
  const [view, setView] = useState<"preview" | "source">("preview");
  const [mode, setMode] = useState("action");
  const [pageNumber, setPageNumber] = useState(1);
  const [endWidth, setEndWidth] = useState(240);
  const [startWidth, setStartWidth] = useState(240);
  const dialogs = useDialogs();
  const page = paginate(Array.from({ length: 84 }, (_, i) => i), pageNumber, 25);

  return <main className="flex flex-col gap-6 p-6">
    <h1>Design system</h1>
    <div className="flex flex-wrap gap-3">
      <Button onClick={() => document.documentElement.dataset.theme = "light"}>Light theme</Button>
      <Button onClick={() => document.documentElement.dataset.theme = "dark"}>Dark theme</Button>
      <Button onClick={() => setDrawer(true)}>Open drawer</Button>
      <Button onClick={() => void dialogs.prompt({ title: "Example prompt", defaultValue: "Draft" })}>Open prompt</Button>
      <Button onClick={() => toast.add({ title: "Saved", description: "Changes saved", timeout: 0 })}>Show toast</Button>
    </div>

    {/* Kept as one row so the existing spec's "Small button" / "Page select" /
        "Disabled action" / "Example switch" locators keep resolving. */}
    <Card><div className="flex flex-wrap items-center gap-4">
      <Button size="sm">Small button</Button><ExampleSelect label="Small select" size="sm" />
      <Button variant="outline" disabled>Disabled action</Button>
      <Button loading>Loading action</Button>
      <Input aria-label="Page input" /><Input aria-label="Disabled input" disabled />
      <ExampleSelect label="Page select" />
      <Switch aria-label="Example switch" />
      <Checkbox aria-label="Example checkbox" />
    </div></Card>

    <Card><div className="flex flex-wrap items-center gap-3">
      <Badge variant="state" className="tone-warn" data-testid="warning-badge">Warning</Badge>
      <Badge variant="state" className="tone-bad" data-testid="error-badge">Error</Badge>
      <Badge variant="state" className="tone-live" data-testid="live-badge">Live</Badge>
      <RoutineStateBadge state="overdue" /><Alert variant="boxed">Unable to save</Alert>
    </div></Card>

    {/* ---- Button matrix: every variant at every size ---- */}
    <Section title="Button variants">
      {BUTTON_VARIANTS.map((variant) => (
        <Button key={variant} variant={variant} aria-label={variant === "icon" ? `${variant} button` : undefined}>
          {variant === "icon" ? <NavPreferences size={ICON.md} /> : variant}
        </Button>
      ))}
    </Section>
    <Section title="Button sizes">
      {BUTTON_SIZES.map((size) => (
        <Button key={size} size={size as ButtonProps["size"]}>{size}</Button>
      ))}
    </Section>
    <Section title="Icon button sizes">
      {ICON_SIZES.map((size) => (
        <Button key={size} variant="icon" size={size as ButtonProps["size"]} aria-label={`${size} action`}>
          <NavPreferences />
        </Button>
      ))}
    </Section>
    <Section title="Icon button modifiers">
      <Button variant="icon" aria-label="Neutral icon action"><NavPreferences /></Button>
      <Button variant="icon" tinted aria-label="Tinted icon action"><NavPreferences /></Button>
      <Button variant="icon" danger aria-label="Danger icon action"><ActionRemove /></Button>
      <Button variant="destructive">Destructive</Button>
      <Button variant="default" disabled>Disabled fill</Button>
      <Button variant="destructive" disabled>Disabled destructive</Button>
      <Button tooltip="Tooltip label" variant="icon" aria-label="Tooltipped action"><NavPreferences /></Button>
    </Section>

    {/* ---- Badge tones ---- */}
    <Section title="Badge tones">
      <Badge variant="neutral">Neutral</Badge>
      <Badge variant="success">Success</Badge>
      <Badge variant="info">Info</Badge>
      <Badge variant="warning">Warning</Badge>
      <Badge variant="danger">Danger</Badge>
      <StatusPill value="running" />
    </Section>

    {/* ---- Consolidated chips ----
        The three chips that used to draw their own geometry, rendered beside
        the primitive above so a divergence is visible rather than argued
        about. Each should differ from a plain neutral Badge ONLY in fill, ink,
        or its own layout residue — never in radius, hairline, inline pad, or
        label size. If one of these looks like a different shape from the
        Neutral badge overhead, that is the regression this section exists to
        catch. */}
    <Section title="Consolidated chips">
      <Badge variant="neutral" className="badge-probe-ref">Neutral (reference)</Badge>
      <Badge className="adm-agent-inventory-pill code">skill-name</Badge>
      <Badge className="adm-dash-empty-tag">Coming soon</Badge>
      <Badge className="pref-lang-badge">EN</Badge>
      <Badge className="pref-lang-badge">简</Badge>
    </Section>

    {/* ---- Form stack ---- */}
    <Section title="Field">
      <div className="flex min-w-0 flex-col gap-4">
        <Field label="Plain field" hint="A hint under the control.">
          <Input aria-label="Plain field input" />
        </Field>
        <Field label="Required field" required error="This field is required." errorId="specimen-error">
          <Input aria-label="Required field input" aria-invalid="true" aria-describedby="specimen-error" />
        </Field>
        <Field label="Optional field" optional="Optional" wrapper="div" htmlFor="specimen-select">
          <ExampleSelect label="Field select" />
        </Field>
        <Field label="Disabled field" disabled>
          <Input aria-label="Disabled field input" disabled />
        </Field>
        <div className="flex flex-col gap-1">
          <Label>Standalone label</Label>
          <FieldError>Standalone field error</FieldError>
        </div>
      </div>
    </Section>

    <Section title="Radio group">
      <RadioGroup value={mode} onValueChange={(value) => setMode(String(value))} aria-label="Example radio group">
        <label className="flex items-center gap-2 text-xs text-body">
          <RadioGroupItem value="action" /> Action
        </label>
        <label className="flex items-center gap-2 text-xs text-body">
          <RadioGroupItem value="review" /> Review
        </label>
      </RadioGroup>
      {/* The unstyled skin: semantics only, the caller draws the selected shape. */}
      <RadioGroup value={mode} onValueChange={(value) => setMode(String(value))} aria-label="Example radio choices" className="flex">
        <RadioGroupChoice value="action" className="rounded-md border border-hairline px-3 py-1.5 text-xs data-checked:border-hairline-strong data-checked:bg-surface-strong">Action</RadioGroupChoice>
        <RadioGroupChoice value="review" className="rounded-md border border-hairline px-3 py-1.5 text-xs data-checked:border-hairline-strong data-checked:bg-surface-strong">Review</RadioGroupChoice>
      </RadioGroup>
    </Section>

    <Section title="Toggle group">
      <ToggleGroup value={[view]} onValueChange={(value) => setView((value[0] as "preview" | "source") ?? "preview")} aria-label="Example view switch">
        <ToggleGroupItem value="preview" className="rounded-md px-3 py-1.5 text-xs data-pressed:bg-surface-strong">Preview</ToggleGroupItem>
        <ToggleGroupItem value="source" className="rounded-md px-3 py-1.5 text-xs data-pressed:bg-surface-strong">Source</ToggleGroupItem>
      </ToggleGroup>
    </Section>

    <Section title="Search input">
      <SearchInput className="flex items-center gap-2 rounded-md border border-input px-3" inputClassName="h-(--control-h-sm) bg-transparent text-xs outline-none" label="Example search" placeholder="Example search" />
    </Section>

    {/* ---- Disclosure and navigation ---- */}
    <Section title="Dropdown menu">
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline">Open menu</Button>} />
        <DropdownMenuContent>
          {/* A label only names a group, so it lives inside one. */}
          <DropdownMenuGroup>
            <DropdownMenuLabel>Example group</DropdownMenuLabel>
            <DropdownMenuItem>First action</DropdownMenuItem>
            <DropdownMenuItem>Second action</DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem danger>Destructive action</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Tooltip content="A styled tooltip"><Button variant="ghost">Hover me</Button></Tooltip>
    </Section>

    <Section title="Tabs">
      <Tabs value={tab} onValueChange={(value) => setTab(String(value))} className="flex min-w-0 flex-col gap-3">
        <TabsList className="gap-1" aria-label="Example tabs">
          <TabsTrigger value="first" className="rounded-md px-3 py-1.5 text-xs data-selected:bg-surface-strong">First</TabsTrigger>
          <TabsTrigger value="second" className="rounded-md px-3 py-1.5 text-xs data-selected:bg-surface-strong">Second</TabsTrigger>
        </TabsList>
        <TabsContent value="first" className="text-xs text-body">First panel</TabsContent>
        <TabsContent value="second" className="text-xs text-body">Second panel</TabsContent>
      </Tabs>
    </Section>

    {/* ---- Data ---- */}
    <Section title="Table">
      <Table aria-label="Example table">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Name</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {["First", "Second"].map((name) => (
            <TableRow key={name}>
              <TableCell>{name}</TableCell>
              <TableCell><StatusPill value="ready" /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>

    <Section title="Pagination">
      <div className="flex w-full flex-col gap-4">
        <Pagination page={page} onPageChange={setPageNumber} label="Examples" />
        <Pagination page={page} onPageChange={setPageNumber} label="Examples (compact)" compact />
      </div>
    </Section>

    {/* ---- Card slots ---- */}
    <section className="flex flex-col gap-3">
      <h2 className="m-0 text-md font-bold text-ink">Card</h2>
      <div className="flex flex-wrap items-start gap-4">
        <Card className="w-72">
          <CardHeader>
            <CardTitle>Card title</CardTitle>
            <CardDescription>The description slot, one tier down.</CardDescription>
            <CardAction><Badge variant="info">Action</Badge></CardAction>
          </CardHeader>
          <CardContent className="text-xs text-body">Content sits under the header.</CardContent>
          <CardFooter className="border-t"><Button size="dense" variant="outline">Footer action</Button></CardFooter>
        </Card>
        <Card className="w-72" variant="interactive">
          <CardHeader><CardTitle>Interactive</CardTitle><CardDescription>Hairline strengthens on hover.</CardDescription></CardHeader>
        </Card>
        <Card className="w-72" padding="compact">
          <CardHeader><CardTitle>Compact padding</CardTitle></CardHeader>
        </Card>
      </div>
    </section>

    <Section title="Alert">
      <div className="flex w-full flex-col gap-3">
        <Alert>Inline failure message</Alert>
        <Alert variant="boxed">Boxed failure message</Alert>
      </div>
    </Section>

    {/* Both orientations, because `grows` is the one prop that can silently
        invert: a splitter whose arrow keys run backwards still looks correct
        in a screenshot and only fails under the hand. */}
    <Section title="Resize handle">
      <div className="flex w-full flex-col gap-3">
        <span className="text-xs text-body">Grows inline-end: {endWidth}px</span>
        <ResizeHandle
          className="h-4 w-full cursor-col-resize rounded-sm bg-surface-strong"
          label="Grows inline-end"
          width={endWidth}
          min={100}
          max={400}
          defaultWidth={240}
          grows="inline-end"
          clamp={(w, max) => Math.min(Math.max(100, w), max)}
          ceiling={() => 400}
          onResize={(w) => setEndWidth(w)}
          onResizeActive={() => {}}
        />
        <span className="text-xs text-body">Grows inline-start: {startWidth}px</span>
        <ResizeHandle
          className="h-4 w-full cursor-col-resize rounded-sm bg-surface-strong"
          label="Grows inline-start"
          width={startWidth}
          min={100}
          max={400}
          defaultWidth={240}
          grows="inline-start"
          clamp={(w, max) => Math.min(Math.max(100, w), max)}
          ceiling={() => 400}
          onResize={(w) => setStartWidth(w)}
          onResizeActive={() => {}}
        />
      </div>
    </Section>

    <Drawer open={drawer} onClose={() => setDrawer(false)} title="Example drawer" closeLabel="Close drawer"><OverlayFields /></Drawer>
  </main>;
}
