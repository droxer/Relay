"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { Drawer } from "@/components/ui/Drawer";
import { toast } from "@/components/ui/toast";
import { RoutineStateBadge } from "@/components/RoutineStateBadge";

function ExampleSelect({ label, size = "default" }: { label: string; size?: "default" | "sm" }) {
  return <Select defaultValue="one"><SelectTrigger aria-label={label} size={size}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="one">First option</SelectItem><SelectItem value="two">Second option</SelectItem></SelectContent></Select>;
}

function OverlayFields() {
  return <div className="flex flex-col gap-4">
    <Input aria-label="Overlay input" />
    <Input aria-label="Invalid overlay input" aria-invalid="true" />
    <Textarea aria-label="Overlay notes" />
    <ExampleSelect label="Overlay select" />
  </div>;
}

/** Real UI primitives, no API calls or persisted example records. */
export function DesignSystemSpecimen() {
  const [drawer, setDrawer] = useState(false);
  return <main className="flex flex-col gap-6 p-6">
    <h1>Design system</h1>
    <div className="flex flex-wrap gap-3">
      <Button onClick={() => document.documentElement.dataset.theme = "light"}>Light theme</Button>
      <Button onClick={() => document.documentElement.dataset.theme = "dark"}>Dark theme</Button>
      <Button onClick={() => setDrawer(true)}>Open drawer</Button>
      <Button onClick={() => toast.add({ title: "Saved", description: "Changes saved", timeout: 0 })}>Show toast</Button>
    </div>
    <Card><div className="flex flex-wrap items-center gap-4">
      <Button size="sm">Small button</Button><ExampleSelect label="Small select" size="sm" />
      <Button variant="outline" disabled>Disabled action</Button>
      <Button loading>Loading action</Button>
      <Input aria-label="Page input" /><Input aria-label="Disabled input" disabled />
      <ExampleSelect label="Page select" />
      <Switch aria-label="Example switch" />
      <Checkbox aria-label="Example checkbox" />
    </div></Card>
    <Card><div className="flex flex-wrap gap-3">
      <Badge variant="state" className="tone-warn" data-testid="warning-badge">Warning</Badge>
      <Badge variant="state" className="tone-bad" data-testid="error-badge">Error</Badge>
      <Badge variant="state" className="tone-live" data-testid="live-badge">Live</Badge>
      <RoutineStateBadge state="overdue" /><Alert variant="boxed">Unable to save</Alert>
    </div></Card>
    <Drawer open={drawer} onClose={() => setDrawer(false)} title="Example drawer" closeLabel="Close drawer"><OverlayFields /></Drawer>
  </main>;
}
