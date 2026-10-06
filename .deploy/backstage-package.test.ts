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
  stat,
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
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
test("[unit] B8 network-failure curl exits are recorded as 000/<exit>", () => {
  for (const code of [6, 7, 28, 35, 52, 56, 58, 60]) {
    const result = Bun.spawnSync(
      [
        "bash",
        "-c",
        `source .deploy/backstage-lib.sh; curl(){ printf 000; return ${code}; }; backstage_probe_neighbours 127.0.0.1 example.test`,
      ],
      { stdout: "pipe" },
    );
    expect(result.exitCode).toBe(0);
    expect(decode(result.stdout)).toBe(`example.test 000/${code}\n`);
  }
});
test("[unit] B8 local curl failures and malformed output fail the probe", () => {
  for (const code of [2, 3, 48, 126, 127]) {
    const result = Bun.spawnSync(
      [
        "bash",
        "-c",
        `source .deploy/backstage-lib.sh; curl(){ echo curl-local-failure >&2; return ${code}; }; backstage_probe_neighbours 127.0.0.1 example.test`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).not.toBe(0);
    expect(decode(result.stdout)).toBe("");
    expect(decode(result.stderr)).toContain("curl-local-failure");
  }
  const script =
    'source .deploy/backstage-lib.sh; curl(){ printf "%s" "$PROBES"; }; backstage_probe_neighbours 127.0.0.1 example.test';
  for (const probes of ["000", "000000", "", "garbage", "99"])
    expect(
      Bun.spawnSync(["bash", "-c", script], {
        env: { ...process.env, PROBES: probes },
      }).exitCode,
    ).not.toBe(0);
});
test("[unit] B8 neighbour_status_changes parses the 000/<exit> token", () => {
  const run = (after: string) =>
    Bun.spawnSync(
      [
        "bash",
        "-c",
        `source .deploy/lib.sh; neighbour_status_changes "a 000/60" "${after}"`,
      ],
      { stdout: "pipe" },
    );
  expect(run("a 000/60").exitCode).toBe(0);
  const changed = run("a 000/7");
  expect(changed.exitCode).not.toBe(0);
  expect(decode(changed.stdout)).toBe("a 000/60 -> 000/7\n");
});
test("[unit] B8 neighbour HTTP codes are recorded as returned", () => {
  const script =
    'source .deploy/backstage-lib.sh; curl(){ printf "%s" "$PROBES"; }; backstage_probe_neighbours 127.0.0.1 example.test';
  const ok = Bun.spawnSync(["bash", "-c", script], {
    env: { ...process.env, PROBES: "200" },
    stdout: "pipe",
  });
  expect(ok.exitCode).toBe(0);
  expect(new TextDecoder().decode(ok.stdout)).toBe("example.test 200\n");
});
test("[unit] B8 an empty neighbour list is still rejected", () => {
  expect(
    Bun.spawnSync(["bash", "-c", "source .deploy/backstage-lib.sh; backstage_probe_neighbours 127.0.0.1"]).exitCode,
  ).not.toBe(0);
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
  expect(result.exitCode).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toBe("example.test 200/28\n");
});
test("[unit] B8 an HTTP status printed before a network failure is kept, and must be 3 digits", () => {
  const run = (printed: string) =>
    Bun.spawnSync(
      [
        "bash",
        "-c",
        `source .deploy/backstage-lib.sh; curl(){ printf '%s' '${printed}'; return 28; }; backstage_probe_neighbours 127.0.0.1 example.test`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
  for (const printed of ["200", "502", "000"]) {
    const result = run(printed);
    expect(result.exitCode).toBe(0);
    expect(decode(result.stdout)).toBe(`example.test ${printed}/28\n`);
  }
  for (const printed of ["", "20", "2000", "abc", "200 "])
    expect(run(printed).exitCode).not.toBe(0);
});

// Run the real entrypoint and EXIT trap; only OS/network commands cross fixture boundaries.
async function activationFixture(
  failRestart: boolean,
  corruptHtml = false,
  options: {
    promote?: boolean;
    first?: boolean;
    unverified?: boolean;
    disabled?: boolean;
    wrongProtocol?: boolean;
    currentV2?: boolean;
    authSnippet?: boolean;
    authAfterLock?: boolean;
    curlConfig?: string;
    sessionGate?: boolean;
    missingTargetGate?: boolean;
    stopped?: boolean;
    mintFailures?: number;
  } = {},
): Promise<{
  code: number;
  current: string;
  log: string;
  output: string;
  curlLog: string;
  remoteLog: string;
  runtimeEnv: string;
}> {
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
    for (const sha of options.promote
      ? options.first
        ? []
        : [oldSha]
      : [oldSha, newSha]) {
      const release = join(dir, "www/jevnotjev-backstage-releases", sha);
      await mkdir(join(release, "site/backstage"), { recursive: true });
      await Bun.write(
        join(release, "release.json"),
        JSON.stringify({
          version: sha,
          protocol:
            options.currentV2 && sha === oldSha ? "backstage/2" : "backstage/1",
          ...(options.sessionGate && !options.missingTargetGate && sha === newSha ? { gate: "session" } : {}),
        }),
      );
      if (!(options.unverified && sha === oldSha))
        await Bun.write(join(release, ".verified"), "yes");
      for (const file of ["app.js", "backstage.css", "index.html"])
        await Bun.write(
          join(release, "site/backstage", file),
          `${sha}-${file}`,
        );
    }
    const current = join(dir, "www/jevnotjev-backstage-current");
    if (!options.first)
      await symlink(
        join(dir, "www/jevnotjev-backstage-releases", oldSha),
        current,
      );
    if (options.promote) {
      await mkdir(join(dir, "scripts"));
      const artifact = join(dir, "built");
      await mkdir(join(artifact, "site/backstage"), { recursive: true });
      for (const file of ["app.js", "backstage.css", "index.html"])
        await Bun.write(
          join(artifact, "site/backstage", file),
          `${newSha}-${file}`,
        );
      await Bun.write(join(artifact, "server.js"), "server");
      await Bun.write(
        join(artifact, "release.json"),
        JSON.stringify({ version: newSha, protocol: "backstage/2", ...(options.sessionGate && !options.missingTargetGate ? { gate: "session" } : {}) }),
      );
      await Bun.write(
        join(dir, "scripts/backstage-build.ts"),
        `console.info(${JSON.stringify(artifact)});`,
      );
      await Bun.write(
        join(dir, ".deploy/backstage-package.ts"),
        await Bun.file(".deploy/backstage-package.ts").text(),
      );
    }
    await Bun.write(
      join(dir, ".deploy/config.sh"),
      `DOMAIN=own.test\nSERVER_HOST=127.0.0.1\nHEALTH_URL=https://own.test\nCURL_PIN=''\nVHOST_AVAILABLE=/fake/vhost\nremote(){ bun "$FIXTURE/remote.ts" "$1"; }\nfail(){ echo "$*" >&2; exit 1; }\nlog_info(){ :; }\nlog_success(){ :; }\nlog_warn(){ :; }\nlog_error(){ echo "$*" >&2; }\n`,
    );
    await Bun.write(
      join(dir, "remote.ts"),
      `import {appendFileSync,existsSync} from 'node:fs';const root=process.env.FIXTURE??'';const command=process.argv[2]??'';appendFileSync(root+'/remote.log',command+'\\n---\\n');if(command.startsWith('test -f /etc/systemd'))process.exit(0);if(command.startsWith('cat /etc/nginx/sites-enabled')){console.info('server_name neighbor.test;');process.exit(0);}const gated=process.env.AUTH_AFTER_LOCK==='1'?existsSync(root+'/lock/jevnotjev-backstage-deploy'):process.env.AUTH_SNIPPET==='1';const snippet=root+(gated?'/snippet-auth.conf':'/snippet-open.conf');const translated=command.replaceAll('/etc/nginx/snippets/jevnotjev-backstage.conf',snippet).replaceAll('/var/www',root+'/www').replaceAll('/var/lock',root+'/lock');const result=Bun.spawnSync(['bash','-c',translated],{env:process.env,stdin:'inherit',stdout:'pipe',stderr:'pipe'});process.stdout.write(new TextDecoder().decode(result.stdout).replaceAll(root+'/www','/var/www'));process.stderr.write(result.stderr);process.exit(result.exitCode);`,
    );
    // Rollback fixtures exercise the staged Basic gate separately from the repo session snippet.
    const basicSnippet = 'location ^~ /backstage/ { auth_basic "Backstage"; auth_basic_user_file /tmp/htpasswd; }\nlocation ^~ /api/backstage/ { auth_basic "Backstage"; auth_basic_user_file /tmp/htpasswd; }\n';
    await Bun.write(join(dir, "snippet-auth.conf"), basicSnippet);
    if (options.sessionGate) await Bun.write(join(dir, "snippet-auth.conf"), await Bun.file(".deploy/backstage-nginx.conf").text());
    await Bun.write(
      join(dir, "snippet-open.conf"),
      'location ^~ /backstage/ {}\nlocation ^~ /api/backstage/ {}\n',
    );
    const commands: Record<string, string> = {
      git: `#!/usr/bin/env bash\ncase "$1" in rev-parse) echo ${newSha};; status|fetch) exit 0;; *) exit 1;; esac\n`,
      gh: `#!/usr/bin/env bun\nconsole.info(JSON.stringify([{merged_at:"yes",base:{ref:"main"},body:"Closes #67"}]));`,
      sleep: "#!/usr/bin/env bash\nexit 0\n",
      mv: `#!/usr/bin/env bun\nimport {renameSync} from 'node:fs';const args=process.argv.slice(2).filter(a=>a!=='-T');renameSync(args[0]??'',args[1]??'');`,
      sha256sum: `#!/usr/bin/env bash\nshasum -a 256 "$@"\n`,
      systemctl: `#!/usr/bin/env bun\nimport {appendFileSync,existsSync,writeFileSync} from 'node:fs';const root=process.env.FIXTURE??'';appendFileSync(root+'/actions',process.argv.slice(2).join(' ')+'\\n');if(process.argv[2]==='is-enabled'&&process.env.DISABLED==='1')process.exit(1);if(process.argv[2]==='restart'){writeFileSync(root+'/restarted','1');if(process.env.FAIL_RESTART==='1'&&!existsSync(root+'/failed')){writeFileSync(root+'/failed','1');process.exit(1);}}`,
      curl: `#!/usr/bin/env bun\nimport {appendFileSync,readlinkSync,readFileSync,writeFileSync,existsSync} from 'node:fs';const args=process.argv.slice(2);const root=process.env.FIXTURE??'';appendFileSync(root+'/curl.log',args.join(' ')+'\\n');const url=args.at(-1)??'';if(url.includes('neighbor.test')){process.stdout.write('200');process.exit(0);}if(process.env.STOPPED==='1'&&!existsSync(root+'/restarted'))process.exit(7);if(url.endsWith('/api/auth/password')){const h=args.indexOf('-D'),j=args.indexOf('-c');if(h>=0)writeFileSync(args[h+1]??'', 'HTTP/1.1 303 See Other\\r\\nSet-Cookie: __Host-backstage_session=fake; Path=/; Secure\\r\\n\\r\\n');if(j>=0)writeFileSync(args[j+1]??'', '#HttpOnly_jevnotjev.breakoutwithai.com\\tTRUE\\t/\\tTRUE\\t0\\t__Host-backstage_session\\tfake-session\\n');process.stdout.write('303');process.exit(0);}const active=readlinkSync(root+'/www/jevnotjev-backstage-current');if(url.endsWith('/health')){process.stdout.write(JSON.stringify({protocol:process.env.WRONG_PROTOCOL==='1'&&active.endsWith('b'.repeat(40))?'backstage/999':JSON.parse(readFileSync(active+'/release.json','utf8')).protocol,version:active.split('/').at(-1)}));}else{const path=url.endsWith('/')?'index.html':url.split('/').at(-1);if(path==='index.html'&&process.env.CORRUPT_HTML==='1')process.stdout.write('old html');else process.stdout.write(readFileSync(active+'/site/backstage/'+path));}`,
    };
    const curlCommand = commands.curl;
    if (!curlCommand) throw new Error("missing curl fixture command");
    commands.curl = curlCommand.replace(
      "if(url.endsWith('/api/auth/password')){",
      "if(url.endsWith('/api/auth/password')){const countFile=root+'/mint-attempts';const count=Number(existsSync(countFile)?readFileSync(countFile,'utf8'):'0')+1;writeFileSync(countFile,String(count));if(count<=Number(process.env.MINT_FAILURES??'0'))process.exit(7);",
    );
    for (const [name, body] of Object.entries(commands)) {
      const path = join(dir, "bin", name);
      await Bun.write(path, body);
      await chmod(path, 0o755);
    }
    const env: Record<string, string | undefined> = {
      ...process.env,
      FIXTURE: dir,
      PATH: `${dir}/bin:${process.env.PATH}`,
      TMPDIR: join(dir, "tmp"),
      FAIL_RESTART: failRestart ? "1" : "0",
      CORRUPT_HTML: corruptHtml ? "1" : "0",
      DISABLED: options.disabled ? "1" : "0",
      WRONG_PROTOCOL: options.wrongProtocol ? "1" : "0",
      AUTH_SNIPPET: options.authSnippet || options.sessionGate ? "1" : "0",
      AUTH_AFTER_LOCK: options.authAfterLock ? "1" : "0",
      STOPPED: options.stopped ? "1" : "0",
      MINT_FAILURES: String(options.mintFailures ?? 0),
    };
    delete env.BACKSTAGE_CURL_CONFIG;
    if (options.curlConfig) env.BACKSTAGE_CURL_CONFIG = options.curlConfig;
    const result = Bun.spawnSync(
      [
        "bash",
        ".deploy/backstage-deploy.sh",
        ...(options.promote ? [] : ["--rollback", newSha]),
      ],
      { cwd: dir, env, stdout: "pipe", stderr: "pipe" },
    );
    const readLog = (name: string) =>
      Bun.file(join(dir, name))
        .text()
        .catch(() => "");
    return {
      code: result.exitCode,
      current:
        (await readlink(current).catch(() => "")).split("/").at(-1) ?? "",
      log: await readLog("actions"),
      output:
        new TextDecoder().decode(result.stderr) +
        new TextDecoder().decode(result.stdout),
      curlLog: await readLog("curl.log"),
      remoteLog: await readLog("remote.log"),
      runtimeEnv: await Bun.file(join(dir, "www/jevnotjev-backstage-releases", newSha, "runtime.env")).text().catch(() => ""),
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
test("[integration] B8 explicit rollback recovers a recognized unverified current release", async () => {
  const result = await activationFixture(false, false, { unverified: true });
  expect(result.code).toBe(0);
  expect(result.current).toBe("b".repeat(40));
});
test("[integration] B8 failed rollback never reactivates an unverified fallback", async () => {
  const result = await activationFixture(true, false, { unverified: true });
  expect(result.code).not.toBe(0);
  expect(result.current).toBe("");
  expect(result.log.match(/restart/g)?.length).toBe(1);
  expect(result.log).toContain("stop jevnotjev-backstage");
});
test("[integration] B8 promote uploads packages and activates a verified pair", async () => {
  const result = await activationFixture(false, false, { promote: true });
  expect(result.code).toBe(0);
  expect(result.current).toBe("b".repeat(40));
  expect(result.log).toContain("is-active --quiet");
});
test("[integration] B8 failed first promotion stops service and clears owned current link", async () => {
  const result = await activationFixture(true, false, {
    promote: true,
    first: true,
  });
  expect(result.code).not.toBe(0);
  expect(result.current).toBe("");
  expect(result.log).toContain("stop jevnotjev-backstage");
});
test("[integration] B8 deployment refuses a service not enabled for reboot", async () => {
  const result = await activationFixture(false, false, { disabled: true });
  expect(result.code).not.toBe(0);
  expect(result.current).toBe("a".repeat(40));
  expect(result.log).not.toContain("restart");
  expect(result.output).toContain("not enabled");
});
test("[integration] AU session gate rejects promotion and rollback without a session release before activation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "backstage-gate-"));
  const config = join(dir, "curl");
  try {
    await Bun.write(config, 'user = "operator@example.test:fake-password"\n');
    await chmod(config, 0o600);
    for (const promote of [true, false]) {
      const result = await activationFixture(false, false, { promote, sessionGate: true, missingTargetGate: true, curlConfig: config });
      expect(result.code).not.toBe(0);
      expect(result.output).toContain('gate');
      expect(result.current).toBe("a".repeat(40));
      expect(result.log).not.toContain("restart");
      expect(result.curlLog).not.toContain("api/auth/password");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("[integration] AU stopped service can be replaced under a session gate without a runtime switch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "backstage-gate-"));
  const config = join(dir, "curl");
  try {
    await Bun.write(config, 'user = "operator@example.test:fake-password"\n');
    await chmod(config, 0o600);
    for (const promote of [true, false]) {
      const result = await activationFixture(false, false, { promote, sessionGate: true, stopped: true, curlConfig: config });
      expect(result.code).toBe(0);
      expect(result.current).toBe("b".repeat(40));
      expect(result.runtimeEnv).not.toContain("BACKSTAGE_REQUIRE_SESSION");
      expect(result.curlLog.match(/api\/auth\/password/g)?.length).toBe(1);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("[integration] AU startup retries failed session mints until the service is ready", async () => {
  const dir = await mkdtemp(join(tmpdir(), "backstage-gate-"));
  const config = join(dir, "curl");
  try {
    await Bun.write(config, 'user = "operator@example.test:fake-password"\n');
    await chmod(config, 0o600);
    const result = await activationFixture(false, false, { sessionGate: true, curlConfig: config, mintFailures: 2 });
    expect(result.code).toBe(0);
    expect(result.current).toBe("b".repeat(40));
    expect(result.curlLog.match(/api\/auth\/password/g)?.length).toBe(3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("[integration] AU failed session promotion stops when previous release lacks the session gate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "backstage-gate-"));
  const config = join(dir, "curl");
  try {
    await Bun.write(config, 'user = "operator@example.test:fake-password"\n');
    await chmod(config, 0o600);
    const result = await activationFixture(true, false, { sessionGate: true, curlConfig: config });
    expect(result.code).not.toBe(0);
    expect(result.current).toBe("");
    expect(result.log).toContain("stop jevnotjev-backstage");
    expect(result.log.match(/restart/g)?.length).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("[integration] A3 auth snippet without BACKSTAGE_CURL_CONFIG fails before any change, naming the variable", async () => {
  for (const promote of [true, false]) {
    const result = await activationFixture(false, false, {
      promote,
      authSnippet: true,
    });
    expect(result.code).not.toBe(0);
    expect(result.current).toBe("a".repeat(40));
    expect(result.log).not.toContain("restart");
    expect(result.output).toContain("BACKSTAGE_CURL_CONFIG");
    expect(result.curlLog).not.toContain("backstage");
    expect(result.remoteLog).not.toContain(".stage-");
    expect(result.remoteLog).not.toContain("ln -sfn");
  }
});
test("[integration] sweep #6 auth state is read under the host lock, so a gate installed meanwhile is seen", async () => {
  for (const promote of [true, false]) {
    const result = await activationFixture(false, false, {
      promote,
      authAfterLock: true,
    });
    expect(result.code).not.toBe(0);
    expect(result.current).toBe("a".repeat(40));
    expect(result.log).not.toContain("restart");
    expect(result.output).toContain("BACKSTAGE_CURL_CONFIG");
    expect(result.remoteLog).not.toContain(".stage-");
    expect(result.remoteLog).not.toContain("ln -sfn");
    const lock = result.remoteLog.indexOf("mkdir /var/lock/jevnotjev-backstage-deploy");
    const read = result.remoteLog.indexOf("S='/etc/nginx/snippets/jevnotjev-backstage.conf'");
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(read).toBeGreaterThan(lock);
    expect(result.remoteLog).toContain("rmdir /var/lock/jevnotjev-backstage-deploy");
  }
});
test("[integration] A3 every Backstage probe passes the curl config; credentials stay in the file", async () => {
  const cfgDir = await mkdtemp(join(tmpdir(), "backstage-cfg-"));
  const config = join(cfgDir, "curl");
  const sentinel = "pw-deploy-NEVER-LOGGED";
  try {
    await Bun.write(config, `user = "tester:${sentinel}"\n`);
    await chmod(config, 0o600);
    for (const promote of [true, false]) {
      const result = await activationFixture(false, false, {
        promote,
        authSnippet: true,
        curlConfig: config,
      });
      expect(result.code).toBe(0);
      expect(result.current).toBe("b".repeat(40));
      const lines = result.curlLog.split("\n").filter((l) => l !== "");
      const backstage = lines.filter((l) => l.includes("backstage"));
      expect(backstage.length).toBeGreaterThanOrEqual(5);
      for (const line of backstage) expect(line).toContain(`--config ${config}`);
      for (const line of lines.filter((l) => l.includes("neighbor.test")))
        expect(line).not.toContain("--config");
      for (const text of [result.curlLog, result.remoteLog, result.output])
        expect(text).not.toContain(sentinel);
    }
  } finally {
    await rm(cfgDir, { recursive: true, force: true });
  }
});
// Runs the REAL remote auth-state command locally against a snippet file (sweep #4/#5).
async function authState(
  snippet: string | null,
  mode = 0o644,
): Promise<{ code: number; out: string }> {
  const dir = await mkdtemp(join(tmpdir(), "backstage-auth-"));
  const path = join(dir, "snippet.conf");
  try {
    if (snippet !== null) {
      await Bun.write(path, snippet);
      await chmod(path, mode);
    }
    const result = Bun.spawnSync(
      [
        "bash",
        "-c",
        'source .deploy/backstage-lib.sh; remote(){ bash -c "${1//\\/etc\\/nginx\\/snippets\\/jevnotjev-backstage.conf/$SNIP}"; }; backstage_auth_state',
      ],
      { env: { ...process.env, SNIP: path }, stdout: "pipe", stderr: "pipe" },
    );
    return {
      code: result.exitCode,
      out: new TextDecoder().decode(result.stdout).trim(),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test("[unit] sweep #4/#5 auth state reflects effective auth in the supported layout, else fails closed", async () => {
  const repo = await Bun.file(".deploy/backstage-nginx.conf").text();
  const open = 'location ^~ /backstage/ {} location ^~ /api/backstage/ {}';
  expect(await authState(repo)).toEqual({ code: 0, out: "session" });
  expect(await authState(open)).toEqual({ code: 0, out: "no" });
  expect(await authState(null)).toEqual({ code: 0, out: "no" });
  const inline =
    'location = /backstage { return 308 /backstage/; }\nlocation ^~ /backstage/ { auth_basic "Backstage"; auth_basic_user_file /etc/jevnotjev-backstage/htpasswd; proxy_pass http://127.0.0.1:3456; }\nlocation ^~ /api/backstage/ { auth_basic "Backstage"; auth_basic_user_file /etc/jevnotjev-backstage/htpasswd; proxy_pass http://127.0.0.1:3456; }\n';
  expect(await authState(inline)).toEqual({ code: 0, out: "yes" });
  expect(await authState(inline.replaceAll('auth_basic "Backstage";', "auth_basic off;"))).toEqual({ code: 0, out: "no" });
  const failClosed = [
    // gate on one location only
    repo.replace("    auth_request /_backstage_session;\n", ""),
    // auth_basic without a user file
    inline.replaceAll("auth_basic_user_file /etc/jevnotjev-backstage/htpasswd;", ""),
    // directives outside the two Backstage locations
    `auth_basic "Backstage";\n${open}`,
    // the API location missing
    open.replace("location ^~ /api/backstage/", "location ^~ /api/other/"),
    repo.replace("auth_request /_backstage_session;", "auth_request /other;"),
    repo.replace("location = /_backstage_session", "location = /other"),
    `${repo}\nlocation ^~ /api/auth/ { auth_basic off; }`,
    `${repo}\nlocation /extra { auth_request /_backstage_session; }`,
  ];
  for (const snippet of failClosed) expect((await authState(snippet)).code).not.toBe(0);
  if (process.getuid?.() !== 0)
    expect((await authState(repo, 0o000)).code).not.toBe(0);
  expect(await authState(`# auth_basic off;\n${repo}`)).toEqual({ code: 0, out: "session" });
});
test("[integration] sweep #8 the documented curl-config command never exposes the password", async () => {
  const docLine = (text: string) =>
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.includes("backstage-curl.XXXXXX"));
  const command = docLine(await Bun.file("docs/DEPLOY.md").text());
  expect(command).toBeDefined();
  const home = join(await mkdtemp(join(tmpdir(), "backstage-home-")), "with space");
  const dest = join(home, ".config/jevnotjev/backstage-curl");
  try {
    await mkdir(join(home, ".config/jevnotjev"), { recursive: true });
    await Bun.write(dest, "stale\n");
    await chmod(dest, 0o644);
    const result = Bun.spawnSync(["bash", "-c", command ?? "exit 9"], {
      env: { ...process.env, HOME: home },
      stdin: new TextEncoder().encode("doc-test-pw\n"),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(await Bun.file(dest).text()).toBe('user = "tester:doc-test-pw"\n');
    const { stat } = await import("node:fs/promises");
    expect((await stat(dest)).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, ".config/jevnotjev"))).mode & 0o077).toBe(0);
    expect(await readdir(join(home, ".config/jevnotjev"))).toEqual(["backstage-curl"]);
    expect(new TextDecoder().decode(result.stdout)).not.toContain("doc-test-pw");
  } finally {
    await rm(join(home, ".."), { recursive: true, force: true });
  }
});
test("[unit] A3 the curl config is required exactly when the snippet has auth", () => {
  const require = (auth: string, config?: string) => {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.BACKSTAGE_CURL_CONFIG;
    if (config !== undefined) env.BACKSTAGE_CURL_CONFIG = config;
    return Bun.spawnSync(
      ["bash", "-c", 'source .deploy/backstage-lib.sh; backstage_require_curl_config "$1"', "t", auth],
      { env, stdout: "pipe", stderr: "pipe" },
    );
  };
  const missing = require("yes");
  expect(missing.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(missing.stderr)).toContain("BACKSTAGE_CURL_CONFIG");
  expect(require("no").exitCode).toBe(0);
  expect(require("unknown").exitCode).not.toBe(0);
  expect(require("yes", "/nonexistent/backstage-curl").exitCode).not.toBe(0);
  const missingSession = require("session");
  expect(missingSession.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(missingSession.stderr)).toContain("BACKSTAGE_CURL_CONFIG");
});

test("[unit] AU S2 session mint keeps credentials out of argv and removes its private jar on exit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "backstage-mint-"));
  try {
    const curl = join(dir, "curl");
    const config = join(dir, "config");
    const log = join(dir, "argv");
    const jarPath = join(dir, "jar-path");
    const priorTrap = join(dir, "prior-trap");
    await Bun.write(config, 'user = "operator@example.test:sentinel-secret"\n');
    await chmod(config, 0o600);
    await Bun.write(curl, '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$MINT_LOG"\nheads=""; jar=""; prev=""; for arg in "$@"; do case "$prev" in -D) heads="$arg";; -c) jar="$arg";; esac; prev="$arg"; done\nif [[ -n "$jar" ]]; then printf "HTTP/1.1 303 See Other\\r\\nSet-Cookie: __Host-backstage_session=fake; Path=/; Secure\\r\\n\\r\\n" > "$heads"; printf "cookie" > "$jar"; printf 303; else printf 200; fi\n');
    await chmod(curl, 0o755);
    const command = 'source .deploy/backstage-lib.sh; trap \'printf prior > "$MINT_PRIOR_TRAP"\' EXIT; BACKSTAGE_GATE=session; backstage_curl -o /dev/null -w "%{http_code}" "$HEALTH_URL/backstage/" >/dev/null; backstage_curl -o /dev/null -w "%{http_code}" "$HEALTH_URL/api/backstage/health" >/dev/null; first="$BACKSTAGE_SESSION_JAR"; bun -e \'import {statSync} from "node:fs"; console.log((statSync(process.argv[1]).mode & 0o777).toString(8))\' "$first"; backstage_session_reset; [[ ! -e "$first" ]] || exit 8; backstage_curl -o /dev/null -w "%{http_code}" "$HEALTH_URL/backstage/" >/dev/null; printf "%s" "$BACKSTAGE_SESSION_JAR" > "$MINT_JAR_PATH"';
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, BACKSTAGE_CURL_CONFIG: config, MINT_LOG: log, MINT_JAR_PATH: jarPath, MINT_PRIOR_TRAP: priorTrap, HEALTH_URL: "https://own.test", CURL_PIN: "" };
    const result = Bun.spawnSync(["bash", "-c", command], { env, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout).trim()).toBe("600");
    const argv = await Bun.file(log).text();
    expect(argv).not.toContain("sentinel-secret");
    expect(argv.match(/api\/auth\/password/g)?.length).toBe(2);
    expect(argv.match(/ -b /g)?.length).toBe(3);
    expect(argv).not.toContain(" -L ");
    const jar = await Bun.file(jarPath).text();
    expect(await stat(jar).catch(() => null)).toBeNull();
    expect(await Bun.file(priorTrap).text()).toBe("prior");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("[unit] AU S2 a failed mint names the curl config and leaves no jar", async () => {
  const dir = await mkdtemp(join(tmpdir(), "backstage-mint-fail-"));
  try {
    const curl = join(dir, "curl");
    const config = join(dir, "config");
    await Bun.write(config, 'user = "operator@example.test:sentinel-secret"\n');
    await chmod(config, 0o600);
    await Bun.write(curl, '#!/usr/bin/env bash\nheads=""; prev=""; for arg in "$@"; do [[ "$prev" != -D ]] || heads="$arg"; prev="$arg"; done\nprintf "HTTP/1.1 401 Unauthorized\\r\\n\\r\\n" > "$heads"; printf 401\n');
    await chmod(curl, 0o755);
    const result = Bun.spawnSync(["bash", "-c", 'source .deploy/backstage-lib.sh; BACKSTAGE_GATE=session; backstage_curl "$HEALTH_URL/backstage/"'], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, BACKSTAGE_CURL_CONFIG: config, HEALTH_URL: "https://own.test", CURL_PIN: "", TMPDIR: dir }, stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(result.stderr)).toContain("BACKSTAGE_CURL_CONFIG");
    expect(new TextDecoder().decode(result.stderr)).not.toContain("sentinel-secret");
    expect((await readdir(dir)).some((name) => name.startsWith("jevnotjev-session."))).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("[unit] JF6 service isolates durable ledger and funded secrets outside release permissions", async () => {
  const service = await Bun.file(".deploy/backstage.service").text();
  expect(service).toContain("User=jevnotjev-backstage");
  expect(service).toContain("StateDirectory=jevnotjev-backstage");
  expect(service).toContain("StateDirectoryMode=0700");
  expect(service).toContain(
    "EnvironmentFile=-/etc/jevnotjev-backstage/trial.env",
  );
  const nginx = await Bun.file(".deploy/backstage-nginx.conf").text();
  expect(nginx).toContain(
    "proxy_set_header X-Backstage-Client-IP $remote_addr;",
  );
  const deploy = await Bun.file(".deploy/backstage-deploy.sh").text();
  expect(deploy).not.toContain("/etc/jevnotjev-backstage/trial.env");
});

test("[integration] JF6 wrong served protocol fails promotion and restores the prior pair", async () => {
  const result = await activationFixture(false, false, {
    promote: true,
    wrongProtocol: true,
  });
  expect(result.code).not.toBe(0);
  expect(result.current).toBe("a".repeat(40));
  expect(result.log.match(/restart/g)?.length).toBe(2);
  expect(result.output).toContain("New API version did not verify");
  expect(result.output).not.toContain("Rollback version did not verify");
});
test("[integration] JF6 explicit rollback from a v2 release accepts the verified v1 target", async () => {
  const result = await activationFixture(false, false, { currentV2: true });
  expect(result.code).toBe(0);
  expect(result.current).toBe("b".repeat(40));
  expect(result.log).toContain("is-active --quiet");
});
