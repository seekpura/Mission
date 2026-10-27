import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { CapabilityCandidate, SecurityAssessment, SecurityFinding } from "../domain/capability.ts";

const rules: Array<{ category: string; severity: "medium" | "high" | "blocked"; re: RegExp; detail: string }> = [
  { category: "privilege", severity: "blocked", re: /\bsudo\b|\bdoas\b/, detail: "Requests privilege escalation" },
  { category: "destructive-shell", severity: "blocked", re: /rm\s+-rf\s+\/(?:\s|$)|mkfs\b/, detail: "Contains destructive host command" },
  { category: "secret-access", severity: "high", re: /\.ssh\b|AWS_SECRET_ACCESS_KEY|SSH_AUTH_SOCK|\.aws\/credentials/, detail: "References sensitive credential material" },
  { category: "download-execute", severity: "high", re: /(curl|wget)[^\n|]*\|\s*(bash|sh)/, detail: "Downloads and directly executes remote code" },
  { category: "dynamic-exec", severity: "medium", re: /\beval\s*\(|\bexec\s*\(|child_process|shell\s*:\s*true/, detail: "Contains dynamic or shell execution" },
  { category: "host-mutation", severity: "high", re: /systemctl|launchctl|crontab|\/etc\//, detail: "May mutate host/system state" }
];

export class StaticSecurityScanner {
  scan(candidate: CapabilityCandidate, root: string): SecurityAssessment {
    const findings: SecurityFinding[] = [];
    for (const file of walk(root)) {
      if (statSync(file).size > 1_000_000) continue;
      let text: string;
      try { text = readFileSync(file, "utf8"); } catch { continue; }
      for (const rule of rules) {
        if (rule.re.test(text)) {
          findings.push({ severity: rule.severity, category: rule.category, detail: rule.detail, file: relative(root, file) });
        }
      }
      const base = file.split(/[\\/]/).pop() ?? "";
      if (["package.json", "pyproject.toml", "setup.py", "Makefile", "install.sh", "setup.sh"].includes(base)) {
        if (/postinstall|preinstall|prepare|install\.sh|setup\.sh/.test(text)) {
          findings.push({ severity: "medium", category: "install-hook", detail: "Contains install/build hook requiring review", file: relative(root, file) });
        }
      }
    }
    const rank = { low: 0, medium: 1, high: 2, blocked: 3 } as const;
    let overall: "low" | "medium" | "high" | "blocked" = "low";
    for (const finding of findings) if (rank[finding.severity] > rank[overall]) overall = finding.severity;
    return {
      candidateId: candidate.id,
      overall,
      findings,
      requestedPermissions: [],
      recommendedAction: overall === "blocked" ? "reject" : overall === "high" ? "approval_required" : "sandbox"
    };
  }
}

function* walk(root: string): Generator<string> {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if ([".git", "node_modules", ".venv", "dist", "build"].includes(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}
