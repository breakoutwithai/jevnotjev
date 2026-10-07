import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const namespace = "jevnotjev-backstage";
const unit = readFileSync(".deploy/backstage.service", "utf8");
const logs = readFileSync("docs/backstage-deploy.md", "utf8").split("## Logs\n")[1]?.split("\n## ")[0] ?? "";

function serviceSection(source: string): string {
  return source.split("[Service]\n")[1]?.split(/\n\[/)[0] ?? "";
}

const confInstall = "install -m 0644 .deploy/journald@jevnotjev-backstage.conf /etc/systemd/journald@jevnotjev-backstage.conf";
const journalRestart = "systemctl try-restart systemd-journald@jevnotjev-backstage.service";
const unitInstall = "install -m 0644 " + ".deploy/backstage.service";

// Match command lines and Markdown inline commands, not quoted fixture strings in this test.
function staleBackstageReader(line: string): boolean {
  return line.split(/\|\||&&|[|;]/).some((segment) => {
    const commands = [...segment.matchAll(/(?:^|[\s`])journalctl\b/g)];
    return commands.some((command, index) => {
      const start = (command.index ?? 0) + command[0].length;
      const end = commands[index + 1]?.index ?? segment.length;
      const args = segment.slice(start, end).split("`")[0] ?? "";
      if (/(?:^|\s)--namespace(?:=|\s+)jevnotjev-backstage(?:\s|$)/.test(args)) return false;
      const unit = /(?:^|\s)(?:-u\s*|--unit(?:=|\s+))(?:("[^"]*"|'[^']*'|\$\{[^}]+\}|\$[A-Za-z_][A-Za-z_0-9]*|[^\s]+))/.exec(args)?.[1];
      if (unit !== undefined) {
        const value = unit.replace(/^["']|["']$/g, "");
        if (value === namespace || value === `${namespace}.service` || value.startsWith("$")) return true;
      }
      return /(?:^|\s)_SYSTEMD_UNIT=(?:jevnotjev-backstage(?:\.service)?)(?=\s|$)/.test(args);
    });
  });
}

function unsafeUnitInstall(source: string): boolean {
  let fenced = false;
  let previous = "";
  for (const line of source.split("\n")) {
    if (/^\s*```/.test(line)) { fenced = !fenced; previous = ""; continue; }
    const unitAt = line.indexOf(unitInstall);
    if (unitAt >= 0 && !line.slice(0, unitAt).includes(confInstall) && !(fenced && previous.includes(confInstall))) return true;
    if (line.trim() && line.trim() !== journalRestart) previous = line;
  }
  return false;
}

function unsafeConfInstall(source: string): boolean {
  const lines = source.split("\n");
  let fenced = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
    const installAt = line.indexOf(confInstall);
    if (installAt < 0) continue;
    if (line.slice(installAt + confInstall.length).startsWith(` && ${journalRestart}`)) continue;
    if (fenced) {
      let next = index + 1;
      while (lines[next]?.trim() === "") next++;
      if (lines[next]?.trim() === journalRestart) continue;
    }
    return true;
  }
  return false;
}

describe("Backstage journal namespace", () => {
  test("[unit] BJ1 unit has exactly one LogNamespace in [Service]", () => {
    expect(serviceSection(unit).match(/^LogNamespace=.*$/gm)).toEqual([`LogNamespace=${namespace}`]);
  });

  test("[unit] BJ2 namespace conf name and exact keys", () => {
    const actualNamespace = serviceSection(unit).match(/^LogNamespace=(.*)$/m)?.[1];
    expect(actualNamespace).toBe(namespace);
    const path = `.deploy/journald@${actualNamespace}.conf`;
    const lines = readFileSync(path, "utf8").split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
    expect(lines[0]).toBe("[Journal]");
    expect(lines.filter((line) => line.startsWith("["))).toEqual(["[Journal]"]);
    expect(lines.slice(1).sort()).toEqual([
      "Storage=persistent", "MaxRetentionSec=1day", "MaxFileSec=1h", "SystemMaxUse=200M",
    ].sort());
  });

  test("[unit] BJ3 matcher fixtures and tracked readers", () => {
    for (const command of [
      "journalctl -u jevnotjev-backstage",
      "journalctl -u jevnotjev-backstage.service",
      "journalctl -ujevnotjev-backstage",
      "journalctl -u \"jevnotjev-backstage\"",
      "journalctl -u 'jevnotjev-backstage.service'",
      "journalctl --unit=jevnotjev-backstage",
      "journalctl --unit=\"jevnotjev-backstage\"",
      "journalctl --unit jevnotjev-backstage",
      "journalctl _SYSTEMD_UNIT=jevnotjev-backstage",
      "journalctl _SYSTEMD_UNIT=jevnotjev-backstage.service",
      "journalctl -o cat -u jevnotjev-backstage",
      "journalctl -u \"$BS_SERVICE\"",
      "journalctl -u ${BS_SERVICE}",
      "journalctl -u jevnotjev-backstage -n 5 | cat; journalctl --namespace=jevnotjev-backstage -n 5",
    ]) expect(staleBackstageReader(command)).toBe(true);
    for (const command of [
      "journalctl -u jevnotjev-backstage-restarts",
      "journalctl -u jevnotjev-monitor",
      "journalctl --namespace=jevnotjev-backstage -u jevnotjev-backstage",
    ]) expect(staleBackstageReader(command)).toBe(false);

    const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
    const hits: string[] = [];
    let allowed = 0;
    for (const path of paths) {
      let content: string;
      try { content = readFileSync(path, "utf8"); } catch { continue; }
      if (content.includes("\0")) continue;
      content.split("\n").forEach((line, index) => {
        if (!staleBackstageReader(line)) return;
        // Dated observation of a historical default-journal query, retained as evidence.
        if (path === "docs/design/backstage-logging.md" && line.includes("returned `-- No entries --` on 2026-10-06")) {
          allowed++;
          return;
        }
        hits.push(`${path}:${index + 1}: ${line}`);
      });
    }
    expect(allowed).toBe(1);
    expect(hits).toEqual([]);
  });

  test("[unit] BJ4 operator commands and systemd 255 citations", () => {
    for (const command of [
      "install -m 0644 .deploy/journald@jevnotjev-backstage.conf /etc/systemd/journald@jevnotjev-backstage.conf",
      `${unitInstall} /etc/systemd/system/jevnotjev-backstage.service`,
      "systemctl daemon-reload",
      "systemctl restart jevnotjev-backstage",
      "systemctl show -p LogNamespace jevnotjev-backstage",
      "journalctl --namespace=jevnotjev-backstage -n 5",
    ]) expect(logs).toContain(command);
    for (const line of logs.split("\n")) {
      if (/^journalctl\s|`journalctl\s/.test(line)) expect(line).toContain("--namespace=jevnotjev-backstage");
    }
    for (const page of ["systemd.exec", "journald.conf", "systemd-journald.service"]) {
      expect(logs).toContain(`freedesktop.org/software/systemd/man/255/${page}`);
    }
  });

  test("[unit] BJ5 every tracked unit install first installs namespace conf and activates it", () => {
    expect(unsafeUnitInstall(`${confInstall} && ${unitInstall} /etc/systemd/system/jevnotjev-backstage.service`)).toBe(false);
    expect(unsafeUnitInstall(`\`\`\`sh\n${confInstall}\n\n${unitInstall} /etc/systemd/system/jevnotjev-backstage.service\n\`\`\``)).toBe(false);
    expect(unsafeUnitInstall(`${unitInstall} /etc/systemd/system/jevnotjev-backstage.service && ${confInstall}`)).toBe(true);
    expect(unsafeConfInstall(`\`\`\`sh\n${confInstall}\n\n${journalRestart}\n\`\`\``)).toBe(false);
    expect(unsafeConfInstall(`${confInstall} && ${journalRestart} && ${unitInstall} /etc/systemd/system/jevnotjev-backstage.service`)).toBe(false);
    expect(unsafeConfInstall(`${confInstall} && ${unitInstall} /etc/systemd/system/jevnotjev-backstage.service && ${journalRestart}`)).toBe(true);
    expect(unsafeConfInstall(`\`\`\`sh\n${confInstall}\n${unitInstall} /etc/systemd/system/jevnotjev-backstage.service\n${journalRestart}\n\`\`\``)).toBe(true);
    const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
    const hits: string[] = [];
    for (const path of paths) {
      let content: string;
      try { content = readFileSync(path, "utf8"); } catch { continue; }
      if (content.includes("\0")) continue;
      if (/\.test\.(?:ts|sh)$/.test(path)) continue; // Fixture strings and assertions are not operator commands.
      if (unsafeUnitInstall(content) || unsafeConfInstall(content)) hits.push(path);
    }
    expect(hits).toEqual([]);
  });
});
