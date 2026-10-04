import { test, expect } from "bun:test";
import { checkRelease } from "./backstage-package.ts";
import {
  mkdtemp,
  rm,
  mkdir,
  readdir,
  chmod,
  symlink,
  readlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("[unit] B67 release package requires matching SHA and complete paired artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "backstage-package-"));
  try {
    await mkdir(join(dir, "site/backstage"), { recursive: true });
    await Bun.write(
      join(dir, "release.json"),
      JSON.stringify({ version: "a".repeat(40) }),
    );
    await expect(checkRelease(dir, "b".repeat(40))).rejects.toThrow();
    await expect(checkRelease(dir, "a".repeat(40))).rejects.toThrow();
    for (const path of [
      "server.js",
      "site/backstage/index.html",
      "site/backstage/app.js",
      "site/backstage/backstage.css",
    ])
      await Bun.write(join(dir, path), "artifact");
    const files = await checkRelease(dir, "a".repeat(40));
    expect(files.length).toBe(5);
    await Bun.write(join(dir, ".env"), "secret");
    await expect(checkRelease(dir, "a".repeat(40))).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("[unit] B67 deploy dry run is inert and unknown options fail closed", () => {
  const run = Bun.spawnSync(
    ["bash", ".deploy/backstage-deploy.sh", "--dry-run"],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(run.exitCode).toBe(0);
  expect(new TextDecoder().decode(run.stdout)).toContain("Would promote");
  expect(
    Bun.spawnSync(["bash", ".deploy/backstage-deploy.sh", "--not-a-flag"], {
      stdout: "pipe",
      stderr: "pipe",
    }).exitCode,
  ).not.toBe(0);
  expect(
    Bun.spawnSync(
      [
        "bash",
        ".deploy/backstage-deploy.sh",
        "--rollback",
        "unsafe;command",
        "--dry-run",
      ],
      { stdout: "pipe", stderr: "pipe" },
    ).exitCode,
  ).not.toBe(0);
});
test("[unit] B67 deployment distinguishes absent, linked and unreachable current release", () => {
  const run = (probe: string, status: string) =>
    Bun.spawnSync(
      [
        "bash",
        "-c",
        'source .deploy/backstage-lib.sh; remote(){ printf "%s" "$PROBE"; return "$PROBE_STATUS"; }; backstage_previous_release /var/www/jevnotjev-backstage-current',
      ],
      {
        env: { ...process.env, PROBE: probe, PROBE_STATUS: status },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
  const absent = run("ABSENT", "0");
  expect(absent.exitCode).toBe(0);
  expect(new TextDecoder().decode(absent.stdout)).toBe("");
  const sha = "a".repeat(40);
  const linked = run(`LINK:/var/www/jevnotjev-backstage-releases/${sha}`, "0");
  expect(linked.exitCode).toBe(0);
  expect(new TextDecoder().decode(linked.stdout).trim()).toBe(
    `/var/www/jevnotjev-backstage-releases/${sha}`,
  );
  for (const [probe, status] of [
    ["", "255"],
    ["", "0"],
    ["ABSENT", "255"],
    ["FOREIGN", "0"],
    ["LINK:/tmp/other", "0"],
  ])
    expect(run(probe ?? "", status ?? "").exitCode).not.toBe(0);
});
test("[unit] B67 deployment rejects untracked shippable source before building", () => {
  const script =
    'source .deploy/backstage-lib.sh; git(){ case "$*" in *--untracked-files=all*"src site scripts .deploy package.json bun.lock tsconfig.json"*) printf "%s" "$DIRTY_SOURCE" ;; *) return 2 ;; esac; }; backstage_clean_sources';
  for (const dirty of [
    "?? src/helper.ts",
    "?? site/private.json",
    " M scripts/backstage-build.ts",
  ])
    expect(
      Bun.spawnSync(["bash", "-c", script], {
        env: { ...process.env, DIRTY_SOURCE: dirty },
        stdout: "pipe",
        stderr: "pipe",
      }).exitCode,
    ).not.toBe(0);
  expect(
    Bun.spawnSync(["bash", "-c", script], {
      env: { ...process.env, DIRTY_SOURCE: "" },
      stdout: "pipe",
      stderr: "pipe",
    }).exitCode,
  ).toBe(0);
});
test("[unit] B67 nginx locations preserve inherited security headers", async () => {
  expect(await Bun.file(".deploy/backstage-nginx.conf").text()).not.toMatch(
    /^\s*add_header\s/m,
  );
});
test("[unit] B8 stylesheet is required by release packaging", async () => {
  const dir = await mkdtemp(join(tmpdir(), "backstage-css-"));
  try {
    await mkdir(join(dir, "site/backstage"), { recursive: true });
    await Bun.write(
      join(dir, "release.json"),
      JSON.stringify({ version: "a".repeat(40) }),
    );
    for (const path of [
      "server.js",
      "site/backstage/index.html",
      "site/backstage/app.js",
    ])
      await Bun.write(join(dir, path), "artifact");
    await expect(checkRelease(dir, "a".repeat(40))).rejects.toThrow(
      "backstage.css",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("[unit] B8 failed first deploy removes only its own current link", async () => {
  const dir = await mkdtemp(join(tmpdir(), "backstage-restore-"));
  try {
    const script =
      'source .deploy/backstage-lib.sh; remote(){ bash -c "$1"; }; backstage_remove_failed_initial "$1" "$2" true';
    const release = join(dir, "release"),
      current = join(dir, "current");
    await mkdir(release);
    await Bun.spawn(["ln", "-s", release, current]).exited;
    expect(
      Bun.spawnSync(["bash", "-c", script, "test", current, join(dir, "other")])
        .exitCode,
    ).not.toBe(0);
    expect(
      Bun.spawnSync(["bash", "-c", script, "test", current, release]).exitCode,
    ).toBe(0);
    expect(Bun.spawnSync(["test", "-L", current]).exitCode).not.toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("[unit] B8 neighbour network failures cannot pass deployment", () => {
  const script =
    'source .deploy/backstage-lib.sh; curl(){ printf "%s" "$PROBES"; }; backstage_probe_neighbours 127.0.0.1 example.test';
  for (const probes of ["000", "000000", ""])
    expect(
      Bun.spawnSync(["bash", "-c", script], {
        env: { ...process.env, PROBES: probes },
      }).exitCode,
    ).not.toBe(0);
  expect(
    Bun.spawnSync(["bash", "-c", script], {
      env: { ...process.env, PROBES: "200" },
    }).exitCode,
  ).toBe(0);
});
test("[unit] B8 partial failed neighbour enumeration is rejected", () => {
  const result = Bun.spawnSync(
    [
      "bash",
      "-c",
      "source .deploy/backstage-lib.sh; list_neighbours(){ echo example.test; return 1; }; backstage_list_neighbours own.test",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(result.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toBe("");
});
test("[unit] B8 retry quarantines only inactive unverified releases", async () => {
  const dir = await mkdtemp(join(tmpdir(), "backstage-retry-"));
  try {
    const release = join(dir, "release"),
      current = join(dir, "current");
    await mkdir(release);
    await Bun.write(join(release, "payload"), "evidence");
    const run = () =>
      Bun.spawnSync(
        [
          "bash",
          "-c",
          'source .deploy/backstage-lib.sh; remote(){ bash -c "$1"; }; backstage_prepare_destination "$1" "$2"',
          "test",
          release,
          current,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
    await Bun.write(join(release, ".verified"), "yes");
    expect(run().exitCode).not.toBe(0);
    await rm(join(release, ".verified"));
    await Bun.spawn(["ln", "-s", release, current]).exited;
    expect(run().exitCode).not.toBe(0);
    await rm(current);
    expect(run().exitCode).toBe(0);
    expect(await Bun.file(join(release, "payload")).exists()).toBe(false);
    const quarantines = await readdir(dir);
    expect(quarantines.length).toBe(1);
    expect(
      await Bun.file(join(dir, quarantines[0] ?? "", "payload")).text(),
    ).toBe("evidence");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("[integration] B8 protected route probes load private curl credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "backstage-curl-"));
  const config = join(dir, "credentials");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      return request.headers.get("authorization") ===
        `Basic ${btoa("tester:test-password")}`
        ? new Response("protected-ok")
        : new Response("unauthorized", { status: 401 });
    },
  });
  try {
    await Bun.write(config, 'user = "tester:test-password"\n');
    await chmod(config, 0o600);
    const env = { ...process.env, BACKSTAGE_CURL_CONFIG: config };
    const child = Bun.spawn(
      [
        "bash",
        "-c",
        'source .deploy/backstage-lib.sh; backstage_check_curl_config && backstage_curl -fsS "$1"',
        "test",
        `http://127.0.0.1:${server.port}/api/backstage/health`,
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stdout).text()).toBe("protected-ok");
    await chmod(config, 0o644);
    expect(
      Bun.spawnSync(
        [
          "bash",
          "-c",
          "source .deploy/backstage-lib.sh; backstage_check_curl_config",
        ],
        { env, stdout: "pipe", stderr: "pipe" },
      ).exitCode,
    ).not.toBe(0);
  } finally {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});
test("[unit] B8 neighbour HTTP headers cannot hide transport failure", () => {
  const result = Bun.spawnSync(
    [
      "bash",
      "-c",
      "source .deploy/lib.sh; source .deploy/backstage-lib.sh; curl(){ printf 200; return 28; }; backstage_probe_neighbours 127.0.0.1 example.test",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(result.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toBe("");
});

// Run the real entrypoint and EXIT trap; only OS/network commands cross fixture boundaries.
async function activationFixture(
  failRestart: boolean,
  corruptHtml = false,
): Promise<{ code: number; current: string; log: string; output: string }> {
  const dir = await mkdtemp(join(tmpdir(), "backstage-activation-"));
  const oldSha = "a".repeat(40),
    newSha = "b".repeat(40);
  try {
    for (const name of [
      ".deploy",
      "bin",
      "www/jevnotjev-backstage-releases",
      "lock",
      "tmp",
    ])
      await mkdir(join(dir, name), { recursive: true });
    for (const name of ["backstage-deploy.sh", "backstage-lib.sh", "lib.sh"])
      await Bun.write(
        join(dir, ".deploy", name),
        await Bun.file(`.deploy/${name}`).text(),
      );
    for (const sha of [oldSha, newSha]) {
      const release = join(dir, "www/jevnotjev-backstage-releases", sha);
      await mkdir(join(release, "site/backstage"), { recursive: true });
      await Bun.write(join(release, ".verified"), "yes");
      for (const file of ["app.js", "backstage.css", "index.html"])
        await Bun.write(
          join(release, "site/backstage", file),
          `${sha}-${file}`,
        );
    }
    const current = join(dir, "www/jevnotjev-backstage-current");
    await symlink(
      join(dir, "www/jevnotjev-backstage-releases", oldSha),
      current,
    );
    await Bun.write(
      join(dir, ".deploy/config.sh"),
      `DOMAIN=own.test\nSERVER_HOST=127.0.0.1\nHEALTH_URL=https://own.test\nCURL_PIN=''\nVHOST_AVAILABLE=/fake/vhost\nremote(){ bun "$FIXTURE/remote.ts" "$1"; }\nfail(){ echo "$*" >&2; exit 1; }\nlog_info(){ :; }\nlog_success(){ :; }\nlog_warn(){ :; }\nlog_error(){ echo "$*" >&2; }\n`,
    );
    await Bun.write(
      join(dir, "remote.ts"),
      `const root=process.env.FIXTURE??'';const command=process.argv[2]??'';if(command.startsWith('test -f /etc/systemd'))process.exit(0);if(command.startsWith('cat /etc/nginx/sites-enabled')){console.info('server_name neighbor.test;');process.exit(0);}const translated=command.replaceAll('/var/www',root+'/www').replaceAll('/var/lock',root+'/lock');const result=Bun.spawnSync(['bash','-c',translated],{env:process.env,stdout:'pipe',stderr:'pipe'});process.stdout.write(new TextDecoder().decode(result.stdout).replaceAll(root+'/www','/var/www'));process.stderr.write(result.stderr);process.exit(result.exitCode);`,
    );
    const commands: Record<string, string> = {
      git: `#!/usr/bin/env bash\nprintf '%s\\n' '${newSha}'\n`,
      sleep: "#!/usr/bin/env bash\nexit 0\n",
      mv: `#!/usr/bin/env bun\nimport {renameSync} from 'node:fs';const args=process.argv.slice(2).filter(a=>a!=='-T');renameSync(args[0]??'',args[1]??'');`,
      sha256sum: `#!/usr/bin/env bash\nshasum -a 256 "$@"\n`,
      systemctl: `#!/usr/bin/env bun\nimport {appendFileSync,existsSync,writeFileSync} from 'node:fs';const root=process.env.FIXTURE??'';appendFileSync(root+'/actions',process.argv.slice(2).join(' ')+'\\n');if(process.argv[2]==='restart'&&process.env.FAIL_RESTART==='1'&&!existsSync(root+'/failed')){writeFileSync(root+'/failed','1');process.exit(1);}`,
      curl: `#!/usr/bin/env bun\nimport {readlinkSync,readFileSync} from 'node:fs';const args=process.argv.slice(2);const url=args.at(-1)??'';if(url.includes('neighbor.test')){process.stdout.write('200');process.exit(0);}const active=readlinkSync((process.env.FIXTURE??'')+'/www/jevnotjev-backstage-current');if(url.endsWith('/health')){process.stdout.write(JSON.stringify({protocol:'backstage/1',version:active.split('/').at(-1)}));}else{const path=url.endsWith('/')?'index.html':url.split('/').at(-1);if(path==='index.html'&&process.env.CORRUPT_HTML==='1')process.stdout.write('old html');else process.stdout.write(readFileSync(active+'/site/backstage/'+path));}`,
    };
    for (const [name, body] of Object.entries(commands)) {
      const path = join(dir, "bin", name);
      await Bun.write(path, body);
      await chmod(path, 0o755);
    }
    const result = Bun.spawnSync(
      ["bash", ".deploy/backstage-deploy.sh", "--rollback", newSha],
      {
        cwd: dir,
        env: {
          ...process.env,
          FIXTURE: dir,
          PATH: `${dir}/bin:${process.env.PATH}`,
          TMPDIR: join(dir, "tmp"),
          FAIL_RESTART: failRestart ? "1" : "0",
          CORRUPT_HTML: corruptHtml ? "1" : "0",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    return {
      code: result.exitCode,
      current: (await readlink(current)).split("/").at(-1) ?? "",
      log: await Bun.file(join(dir, "actions")).text(),
      output: new TextDecoder().decode(result.stderr),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test("[integration] B8 real deploy EXIT trap restores previous pair after restart failure", async () => {
  const result = await activationFixture(true);
  expect(result.code).not.toBe(0);
  expect(result.current).toBe("a".repeat(40));
  expect(result.log.match(/restart/g)?.length).toBe(2);
  expect(result.output).not.toContain("Rollback version did not verify");
});
test("[integration] B8 explicit rollback verifies and keeps requested pair", async () => {
  const result = await activationFixture(false);
  expect(result.code).toBe(0);
  expect(result.current).toBe("b".repeat(40));
  expect(result.log).toContain("is-active --quiet");
});
test("[integration] B8 wrong served HTML triggers actual deployment rollback", async () => {
  const result = await activationFixture(false, true);
  expect(result.code).not.toBe(0);
  expect(result.current).toBe("a".repeat(40));
  expect(result.output).toContain("index.html differs");
});
