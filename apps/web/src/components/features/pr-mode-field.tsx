"use client";

// Whether this feature's sandbox run ends in a pull request. Three states, not
// a checkbox: "inherit" keeps the feature tied to the project's sandbox policy
// (Sandbox settings → Create PR), so changing that default moves every
// inheriting feature with it. "Always"/"Never" pin this one feature.

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { FeaturePrMode } from "@/types";

const PR_MODE_LABELS: Record<FeaturePrMode, string> = {
  inherit: "Inherit project default",
  always: "Always open a PR",
  never: "Never — branch only",
};

const PR_MODE_HINTS: Record<FeaturePrMode, string> = {
  inherit:
    "Follows Sandbox settings → Create PR. Change it there and this feature follows.",
  always: "The queue opens a PR for this feature even if the project default is off.",
  never:
    "The agent pushes its branch but opens no PR — for spikes and throwaway runs.",
};

export function PrModeField({
  value,
  onChange,
  id = "feature-pr-mode",
}: {
  value: FeaturePrMode;
  onChange: (mode: FeaturePrMode) => void;
  id?: string;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Pull request</Label>
      <Select
        value={value}
        onValueChange={(val) => onChange(val as FeaturePrMode)}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(PR_MODE_LABELS) as FeaturePrMode[]).map((mode) => (
            <SelectItem key={mode} value={mode}>
              {PR_MODE_LABELS[mode]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-[10px] text-muted-foreground">{PR_MODE_HINTS[value]}</p>
    </div>
  );
}
