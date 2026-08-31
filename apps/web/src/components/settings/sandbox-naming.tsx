"use client";

import { Box } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SandboxPrefixField } from "@/components/settings/sandbox-prefix-field";

/**
 * The word every generated sandbox name starts with. Names typed per sandbox
 * replace the whole hostname and never see this.
 */
export function SandboxNamingSection() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Box className="h-5 w-5" />
          Sandbox naming
        </CardTitle>
        <CardDescription>
          What generated machine names start with. Sandboxes appear in{" "}
          <code>docker ps</code>, your SSH config and VS Code&apos;s host list —
          this is the word they are grouped under there.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <SandboxPrefixField
          note={
            <p className="text-xs text-muted-foreground">
              Existing sandboxes keep the name they were created with — renaming
              a machine would orphan its container and SSH entry.
            </p>
          }
        />
      </CardContent>
    </Card>
  );
}
