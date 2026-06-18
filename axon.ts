#!/usr/bin/env -S deno run --allow-read --allow-env --allow-run --allow-write
// axon
/**
 * Axon: Multi-Node Parallel SSH Executor & Live Grid TUI Dashboard
 * Features tag-based routing, single-node targeting, file logging, and unattended modes.
 */

import { colors, Command, parseYaml, Secret } from "./deps.ts";

interface CommandConfig {
  name: string;
  aliases?: string[];
  check_command?: string; // Enhancement: Idempotency check
  command: string;
  tags: string[];
}

interface ServerConfig {
  name: string;
  ip: string;
  user: string;
  active: boolean;
  tags: string[];
}

interface YamlConfig {
  commands: CommandConfig[];
  servers: ServerConfig[];
}

function validateYamlConfig(data: unknown, source: string): asserts data is YamlConfig {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    fatal(
      `Error: Invalid YAML structure in ${source}. ` +
      `Expected an object with 'commands' and 'servers'.`,
    );
  }

  const root = data as Record<string, unknown>;

  if (!Array.isArray(root.commands)) {
    fatal(`Error: Invalid configuration in ${source}: 'commands' must be a list.`);
  }

  if (!Array.isArray(root.servers)) {
    fatal(`Error: Invalid configuration in ${source}: 'servers' must be a list.`);
  }

  root.commands.forEach((command, index) => {
    if (!command || typeof command !== "object" || Array.isArray(command)) {
      fatal(`Error: Command entry at index ${index} in ${source} is malformed.`);
    }

    const cmd = command as Record<string, unknown>;

    if (typeof cmd.name !== "string" || cmd.name.trim() === "") {
      fatal(`Error: Command entry at index ${index} in ${source} must have a non-empty 'name'.`);
    }

    if (typeof cmd.command !== "string" || cmd.command.trim() === "") {
      fatal(`Error: Command '${cmd.name ?? index}' must have a non-empty 'command'.`);
    }

    if (cmd.check_command !== undefined && typeof cmd.check_command !== "string") {
      fatal(`Error: Command '${cmd.name}' has invalid 'check_command'; expected a string.`);
    }

    if (!Array.isArray(cmd.tags) || cmd.tags.some((tag) => typeof tag !== "string")) {
      fatal(`Error: Command '${cmd.name}' must have a 'tags' array of strings.`);
    }

    if (cmd.aliases !== undefined && !Array.isArray(cmd.aliases)) {
      fatal(`Error: Command '${cmd.name}' has invalid 'aliases'; expected a list of strings.`);
    }
  });

  root.servers.forEach((server, index) => {
    if (!server || typeof server !== "object" || Array.isArray(server)) {
      fatal(`Error: Server entry at index ${index} in ${source} is malformed.`);
    }

    const srv = server as Record<string, unknown>;

    if (typeof srv.name !== "string" || srv.name.trim() === "") {
      fatal(`Error: Server entry at index ${index} in ${source} must have a non-empty 'name'.`);
    }

    if (typeof srv.ip !== "string" || srv.ip.trim() === "") {
      fatal(`Error: Server '${srv.name}' must have a non-empty 'ip'.`);
    }

    if (typeof srv.user !== "string" || srv.user.trim() === "") {
      fatal(`Error: Server '${srv.name}' must have a non-empty 'user'.`);
    }

    if (typeof srv.active !== "boolean") {
      fatal(`Error: Server '${srv.name}' must have an 'active' boolean flag.`);
    }

    if (!Array.isArray(srv.tags) || srv.tags.some((tag) => typeof tag !== "string")) {
      fatal(`Error: Server '${srv.name}' must have a 'tags' array of strings.`);
    }
  });
}

function listAvailableCommands(parsedData: YamlConfig, options: {
  server?: string;
  tag?: string;
}): void {
  const byServer = options.server !== undefined;
  const byTag = options.tag !== undefined;

  let validServer: ServerConfig | undefined;
  let filteredCommands: CommandConfig[] = parsedData.commands;
  let serverNamesForTag: string[] = [];

  if (byServer) {
    validServer = parsedData.servers.find((s) => s.name === options.server);
    if (!validServer) {
      fatal(`Error: Server '${options.server}' not found in configuration.`);
    }

    filteredCommands = parsedData.commands.filter((cmd) =>
      cmd.tags.some((tag) => validServer!.tags.includes(tag))
    );
  }

  if (byTag) {
    filteredCommands = parsedData.commands.filter((cmd) =>
      cmd.tags.includes(options.tag!) &&
        (!byServer || cmd.tags.some((tag) => validServer!.tags.includes(tag)))
    );

    serverNamesForTag = parsedData.servers
      .filter((server) => server.tags.includes(options.tag!))
      .map((server) => server.name);
  }

  const title = byServer
    ? `Valid commands for server '${validServer!.name}'` 
    : byTag
    ? `Valid commands for tag '${options.tag}'`
    : "Available commands";

  console.log(colors.bold.cyan(`\n=== ${title} ===\n`));

  if (byServer && validServer) {
    console.log(colors.gray(`Server tags: ${validServer.tags.join(", ")}`));
    console.log();
  }

  if (byTag) {
    console.log(colors.gray(`Matching servers: ${serverNamesForTag.length > 0 ? serverNamesForTag.join(", ") : "None"}`));
    console.log();
  }

  if (filteredCommands.length === 0) {
    console.log(colors.yellow("No commands match the requested criteria."));
    Deno.exit(0);
  }

  filteredCommands.forEach((cmd) => {
    const aliasText = cmd.aliases?.length ? ` (aliases: ${cmd.aliases.join(", ")})` : "";
    const validTags = byServer && validServer ? cmd.tags.filter((tag) => validServer!.tags.includes(tag)) : cmd.tags;
    const serversForCommand = byTag ? parsedData.servers.filter((server) => server.tags.includes(options.tag!)).map((server) => server.name) : [];

    console.log(colors.bold(cmd.name) + aliasText);
    if (cmd.check_command) console.log(colors.gray(`  Idempotency Check: ${cmd.check_command}`));
    console.log(`  Tags: ${validTags.join(", ")}`);

    if (byTag && serversForCommand.length > 0) {
      console.log(`  Servers: ${serversForCommand.join(", ")}`);
    }

    console.log();
  });
}

function listAvailableServers(parsedData: YamlConfig, options: {
  server?: string;
  tag?: string;
}): void {
  const byServer = options.server !== undefined;
  const byTag = options.tag !== undefined;

  let validServer: ServerConfig | undefined;
  let filteredServers: ServerConfig[] = parsedData.servers;

  if (byServer) {
    validServer = parsedData.servers.find((s) => s.name === options.server);
    if (!validServer) {
      fatal(`Error: Server '${options.server}' not found in configuration.`);
    }
    filteredServers = [validServer];
  }

  if (byTag) {
    filteredServers = filteredServers.filter((server) => server.tags.includes(options.tag!));
  }

  const title = byServer && byTag
    ? `Server '${options.server}' matching tag '${options.tag}'`
    : byServer
    ? `Server '${options.server}'`
    : byTag
    ? `Servers with tag '${options.tag}'`
    : "Available servers";

  console.log(colors.bold.cyan(`\n=== ${title} ===\n`));

  if (filteredServers.length === 0) {
    console.log(colors.yellow("No servers match the requested criteria."));
    Deno.exit(0);
  }

  filteredServers.forEach((server) => {
    console.log(colors.bold(server.name));
    console.log(`  IP: ${server.ip}`);
    console.log(`  User: ${server.user}`);
    console.log(`  Active: ${server.active ? "yes" : "no"}`);
    console.log(`  Tags: ${server.tags.join(", ")}`);
    console.log();
  });
}

interface ServerStatus {
  config: ServerConfig;
  status: "Success" | "Failed" | "Skipped" | "Offline";
  currentPhase: "Queued" | "Pinging" | "Checking SSH" | "Checking State" | "Running";
  password?: string;
  outputBuffer: string[];
}

let TARGET_COMMAND = "";
let TARGET_CHECK_COMMAND: string | undefined = undefined;
let TARGET_COMMAND_NAME = "";
let TARGET_SCOPE = "";
let IS_UNATTENDED = false;
let IS_VERBOSE = false;

const USER = Deno.env.get("USER") || "default";
const HOME = Deno.env.get("HOME") || "/root";
const LOG_DIR = `/tmp/${USER}/axon`;
const AXON_LOG = "axon.log";

function fatal(message: string): never {
  console.error(colors.red(message));
  Deno.exit(1);
}

try { Deno.mkdirSync(LOG_DIR, { recursive: true }); } catch (_e) {}

async function logToFile(serverName: string, message: string): Promise<void> {
  const timestamp = new Date().toISOString();
  const logPath = `${LOG_DIR}/${serverName.replace(/[^a-zA-Z0-9_-]/g, "_")}.log`;
  const formattedMessage = `[${timestamp}] ${message}\n`;
  try { await Deno.writeTextFile(logPath, formattedMessage, { append: true }); } catch (_e) {}
}

const LAYOUT = {
  cols: 2,
  boxWidth: 55,
  boxHeight: 10,
  logRows: 6,
  startX: (col: number) => col * (LAYOUT.boxWidth - 1) + 1,
  startY: (row: number) => 1 + row * (LAYOUT.boxHeight - 1),
};

function calculateLayout(serverCount: number): void {
  try {
    const { columns, rows } = Deno.consoleSize();
    LAYOUT.cols = serverCount <= 4 ? 2 : Math.ceil(Math.sqrt(serverCount));
    const gridRows = Math.ceil(serverCount / LAYOUT.cols);
    const availableWidth = columns - 2;
    const availableHeight = rows;
    LAYOUT.boxWidth = Math.floor((availableWidth + (LAYOUT.cols - 1)) / LAYOUT.cols);
    LAYOUT.boxHeight = Math.floor((availableHeight + (gridRows - 1)) / gridRows);
    if (LAYOUT.boxWidth < 40) LAYOUT.boxWidth = 40;
    if (LAYOUT.boxHeight < 7) LAYOUT.boxHeight = 7;
    LAYOUT.logRows = Math.max(0, LAYOUT.boxHeight - 4);
  } catch (_e) {}
}

const Terminal = {
  encoder: new TextEncoder(),
  write: (text: string) => Deno.stdout.writeSync(Terminal.encoder.encode(text)),
  enterAltScreen: () => Terminal.write("\x1b[?1049h"),
  leaveAltScreen: () => Terminal.write("\x1b[?1049l"),
  hideCursor: () => Terminal.write("\x1b[?25l"),
  showCursor: () => Terminal.write("\x1b[?25h"),
  clearScreen: () => Terminal.write("\x1b[2J"),
  moveTo: (x: number, y: number) => Terminal.write(`\x1b[${y};${x}H`),
};

async function pingHost(server: ServerConfig): Promise<boolean> {
  const isMac = Deno.build.os === "darwin";
  const timeoutArg = isMac ? "2000" : "2";
  try {
    const command = new Deno.Command("ping", {
      args: ["-c", "1", "-W", timeoutArg, server.ip],
      stdout: "null",
      stderr: "null",
    });
    const { success } = await command.output();
    return success;
  } catch (_e) {
    return true;
  }
}

async function testSshKeyAuth(server: ServerConfig): Promise<boolean> {
  const command = new Deno.Command("ssh", {
    args: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=3", `${server.user}@${server.ip}`, "echo 'AUTH_OK'"],
    stdout: "piped",
    stderr: "piped",
  });
  const { success } = await command.output();
  return success;
}

function drawStaticLayout(servers: ServerStatus[]): void {
  Terminal.clearScreen();
  Terminal.hideCursor();

  const cols = LAYOUT.cols;
  const rows = Math.ceil(servers.length / cols);
  const innerW = LAYOUT.boxWidth - 2;

  for (let r = 0; r < rows; r++) {
    const topY = LAYOUT.startY(r);
    let topLine = "";
    for (let c = 0; c < cols; c++) {
      if (c === 0) topLine += "╔" + "═".repeat(innerW);
      else topLine += "╦" + "═".repeat(innerW);
    }
    topLine += "╗";
    Terminal.moveTo(1, topY);
    Terminal.write(topLine);

    for (let h = 1; h < LAYOUT.boxHeight - 1; h++) {
      let midLine = "";
      for (let c = 0; c < cols; c++) {
        midLine += "║" + " ".repeat(innerW);
      }
      midLine += "║";
      Terminal.moveTo(1, topY + h);
      Terminal.write(midLine);
    }

    let bottomLine = "";
    for (let c = 0; c < cols; c++) {
      if (c === 0) bottomLine += "╚" + "═".repeat(innerW);
      else bottomLine += "╩" + "═".repeat(innerW);
    }
    bottomLine += "╝";
    Terminal.moveTo(1, topY + LAYOUT.boxHeight - 1);
    Terminal.write(bottomLine);
  }
}

function updateGridCell(server: ServerStatus, index: number): void {
  const col = index % LAYOUT.cols;
  const row = Math.floor(index / LAYOUT.cols);
  const startX = LAYOUT.startX(col) + 1;
  const startY = LAYOUT.startY(row) + 1;
  const innerWidth = LAYOUT.boxWidth - 2;

  let statusColor = colors.yellow;
  if (server.status === "Success") statusColor = colors.green;
  if (server.status === "Failed") statusColor = colors.red;
  if (server.status === "Skipped") statusColor = colors.gray;
  if (server.status === "Offline") statusColor = colors.red;

  let phaseText = server.currentPhase;
  if (server.status !== "Success" && server.status !== "Failed" && server.status !== "Skipped" && server.status !== "Offline") {
    phaseText = server.currentPhase;
  } else {
    phaseText = server.status;
  }

  const headerText = `${colors.bold(server.config.name)} (${server.config.ip})`;
  const statusText = `${statusColor(phaseText)}`;
  const combinedHeader = `${headerText} ${statusText}`;

  Terminal.moveTo(startX, startY);
  let safeHeader = combinedHeader;
  if (safeHeader.length > innerWidth) {
    safeHeader = safeHeader.substring(0, innerWidth - 3) + "...";
  }
  Terminal.write(safeHeader.padEnd(innerWidth));

  Terminal.moveTo(startX, startY + 1);
  Terminal.write("─".repeat(innerWidth));

  const logsToDisplay = server.outputBuffer.slice(-LAYOUT.logRows);
  while (logsToDisplay.length < LAYOUT.logRows) {
    logsToDisplay.push("");
  }

  logsToDisplay.forEach((line, lineIndex) => {
    let cleanLine = line.replace(/\t/g, "    ").trim();
    if (cleanLine.length > innerWidth) {
      cleanLine = cleanLine.substring(0, innerWidth - 3) + "...";
    }
    Terminal.moveTo(startX, startY + 2 + lineIndex);
    Terminal.write(colors.gray(cleanLine.padEnd(innerWidth)));
  });
}

async function isSshpassInstalled(): Promise<boolean> {
  try {
    const command = new Deno.Command("sshpass", {
      args: ["-V"],
      stdout: "null",
      stderr: "null",
    });
    await command.output();
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}

async function executeServerTask(server: ServerStatus): Promise<void> {
  if (server.status === "Skipped" || server.status === "Offline") return;

  // Phase 1: Ping the host
  server.currentPhase = "Pinging";
  await logToFile(server.config.name, `--- Starting Command [${TARGET_COMMAND_NAME}] ---`);

  const isOnline = await pingHost(server.config);
  if (!isOnline) {
    server.status = "Offline";
    server.outputBuffer.push("Host unreachable (ping failed).");
    await logToFile(server.config.name, `Reason: Host did not respond to ping.`);
    return;
  }

  // Phase 2: Check SSH auth
  server.currentPhase = "Checking SSH";
  const hasKey = await testSshKeyAuth(server.config);

  if (!hasKey && !server.password) {
    server.status = "Skipped";
    server.outputBuffer.push("Skipped: Authentication required.");
    await logToFile(server.config.name, `Reason: Node requires interactive password authentication.`);
    return;
  }

  // Common SSH Args
  let baseArgs = [
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=10",
    `${server.config.user}@${server.config.ip}`
  ];

  let execBinary = "ssh";
  if (server.password) {
    execBinary = "sshpass";
    baseArgs = ["-p", server.password, "ssh", ...baseArgs];
  }

  // Phase 3: Idempotency Check (Enhancement)
  if (TARGET_CHECK_COMMAND) {
    server.currentPhase = "Checking State";
    
    const checkCommand = new Deno.Command(execBinary, {
      args: [...baseArgs, TARGET_CHECK_COMMAND],
      stdout: "null", // We only care about exit code for the check
      stderr: "null",
    });

    const checkResult = await checkCommand.output();
    
    // If the check command returns 0 (success), desired state is already met
    if (checkResult.success) {
      server.status = "Success";
      server.outputBuffer.push("Desired state already met. Task skipped.");
      await logToFile(server.config.name, `--- Skipped: Idempotency check passed ---`);
      return;
    }
  }

  // Phase 4: Execute the command
  server.currentPhase = "Running";
  const command = new Deno.Command(execBinary, {
    args: [...baseArgs, TARGET_COMMAND],
    stdout: "piped",
    stderr: "piped",
  });

  const child = command.spawn();

  const readStream = async (stream: ReadableStream<Uint8Array>, isErrorStream: boolean) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let partialLine = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = (partialLine + chunk).split("\n");
        partialLine = lines.pop() ?? "";

        for (const line of lines) {
          if (line.trim().length > 0) {
            server.outputBuffer.push(line);
            if (IS_VERBOSE) {
              const streamTag = isErrorStream ? "[STDERR]" : "[STDOUT]";
              await logToFile(server.config.name, `${streamTag} ${line.trim()}`);
            }
          }
        }
      }
    } catch (_err) {} finally {
      reader.releaseLock();
    }
  };

  await Promise.all([
    readStream(child.stdout, false),
    readStream(child.stderr, true),
  ]);

  const status = await child.status;
  server.status = status.success ? "Success" : "Failed";
  await logToFile(server.config.name, `--- Completion Status: ${server.status} ---`);
}

async function main() {
  try {
    const { options, args } = await new Command()
      .name("axon")
      .description(`Run commands on multiple servers, provide the command or one of these special commands
'commands' list available commands and their tags
'servers'  list available servers and their tags       
`)
      .arguments('<command_name:string>')
      .option("-c, --config <file:string>", "Path to the YAML configuration file", { default: `${HOME}/.axon_config.yml` })
      .option("-t, --tag <tag:string>", "The server tag to target (e.g., pi, linux, mac)")
      .option("-s, --server <server:string>", "The specific server name to target")
      .option("-u, --unattended", "Run silently without TUI and skip interactive password prompts")
      .option("-v, --verbose", "Enable verbose file logging (captures full stdout/stderr)")
      .parse(Deno.args);

    if (options.tag && options.server && args[0] !== "commands" && args[0] !== "servers") {
      fatal("Error: Cannot use both --tag and --server simultaneously. Please choose one.");
    }

    IS_UNATTENDED = !!options.unattended;
    IS_VERBOSE = !!options.verbose;
    const requestedCommandName = args[0];
    const CONFIG_FILE = options.config;

    let rawYaml;
    try {
      rawYaml = await Deno.readTextFile(CONFIG_FILE);
    } catch (_err) {
      fatal(`Error: Could not read configuration file at ${CONFIG_FILE}\nPlease ensure the file exists or pass a valid path using -c/--config`);
    }

    const parsedData = parseYaml(rawYaml);
    validateYamlConfig(parsedData, CONFIG_FILE);

    if (requestedCommandName === "commands") {
      listAvailableCommands(parsedData, { server: options.server, tag: options.tag });
      return;
    }

    if (requestedCommandName === "servers") {
      listAvailableServers(parsedData, { server: options.server, tag: options.tag });
      return;
    }

    const cmdConfig = parsedData.commands.find((c) =>
      c.name === requestedCommandName || (c.aliases?.includes(requestedCommandName) ?? false)
    );

    if (!cmdConfig) {
      fatal(`Error: Command '${requestedCommandName}' not found in ${CONFIG_FILE}. Use 'axon commands' to see available commands.`);
    }

    TARGET_COMMAND = cmdConfig.command;
    TARGET_CHECK_COMMAND = cmdConfig.check_command;
    TARGET_COMMAND_NAME = cmdConfig.name;

    let targetServers: ServerConfig[] = [];

    if (options.server) {
      const server = parsedData.servers.find((s) => s.name === options.server);
      if (!server) fatal(`Error: Server '${options.server}' not found in configuration.`);
      const hasValidTag = server.tags.some((tag) => cmdConfig.tags.includes(tag));
      if (!hasValidTag) fatal(`Error: Command '${requestedCommandName}' is not valid for server '${server.name}'.`);
      TARGET_SCOPE = `Server: ${server.name}`;
      targetServers = [server];
    } else if (options.tag) {
      if (!cmdConfig.tags.includes(options.tag)) fatal(`Error: The command '${requestedCommandName}' is not valid for tag '${options.tag}'.`);
      TARGET_SCOPE = `Tag: ${options.tag}`;
      targetServers = parsedData.servers.filter((s) => s.tags.includes(options.tag!));
    } else {
      TARGET_SCOPE = "All matching axons";
      targetServers = parsedData.servers.filter((s) => s.tags.some((tag) => cmdConfig.tags.includes(tag)));
    }

    const activeServers = targetServers.filter((s) => s.active);

    if (activeServers.length === 0) {
      if (IS_UNATTENDED) await logToFile(AXON_LOG, "No active servers found for the requested criteria. Task complete.");
      else console.log(colors.yellow(`No active servers found for the requested criteria. Task complete.`));
      Deno.exit(0);
    }

    const serverStatuses: ServerStatus[] = activeServers.map((config) => ({
      config,
      status: "Success" as const,
      currentPhase: "Queued" as const,
      outputBuffer: ["Queued for execution."],
    }));

    if (!IS_UNATTENDED) {
      console.log(`${colors.bold.cyan(`=== Step 1: Pre-Flight Password Collection for ${TARGET_SCOPE} ===`)}`);
      for (const server of serverStatuses) {
        const hasKey = await testSshKeyAuth(server.config);
        if (!hasKey) {
          console.log(`${colors.yellow(`⚠️  No SSH Key found for ${server.config.name}.`)}`);
          const pwd = await Secret.prompt({ message: `Enter password for ${server.config.user}@${server.config.ip}:` });
          server.password = pwd;
        }
      }
    } else {
      await logToFile(AXON_LOG, `[Unattended Mode] Executing '${TARGET_COMMAND_NAME}' on ${TARGET_SCOPE}.`);
    }

    const requiresSshpass = serverStatuses.some((server) => server.password !== undefined);

    if (requiresSshpass) {
      const sshpassExists = await isSshpassInstalled();
      if (!sshpassExists) {
        console.error(`\n${colors.bold.red("Dependency Error: 'sshpass' is not installed.")}`);
        console.error(colors.yellow("You have nodes that require password authentication, which relies on 'sshpass'."));
        console.error("Please install it using one of the following commands:");
        console.error(colors.gray("  Ubuntu/Debian:  sudo apt install sshpass"));
        console.error(colors.gray("  macOS:          brew install esolitos/ipa/sshpass"));
        console.error(colors.gray("  CentOS/RHEL:    sudo yum install sshpass\n"));
        Deno.exit(1);
      }
    }

    let uiInterval: ReturnType<typeof setInterval> | undefined;

    if (!IS_UNATTENDED) {
      calculateLayout(serverStatuses.length);
      Terminal.enterAltScreen();
      drawStaticLayout(serverStatuses);

      uiInterval = setInterval(() => {
        serverStatuses.forEach((server, index) => {
          updateGridCell(server, index);
        });
      }, 100);
    }

    // Enhancement: Concurrency Batching (Max 10 at a time)
    const CONCURRENCY_LIMIT = 10;
    for (let i = 0; i < serverStatuses.length; i += CONCURRENCY_LIMIT) {
      const batch = serverStatuses.slice(i, i + CONCURRENCY_LIMIT);
      const workers = batch.map((server) => executeServerTask(server));
      await Promise.all(workers);
    }

    const total = serverStatuses.length;
    const successCount = serverStatuses.filter((s) => s.status === "Success").length;
    const failedCount = serverStatuses.filter((s) => s.status === "Failed").length;
    const offlineCount = serverStatuses.filter((s) => s.status === "Offline").length;
    const skippedCount = serverStatuses.filter((s) => s.status === "Skipped").length;
    const failures = total - successCount;

    if (!IS_UNATTENDED) {
      clearInterval(uiInterval);
      serverStatuses.forEach((server, index) => updateGridCell(server, index));
      Terminal.write("\n\n" + colors.bold.cyan("Completed - Press any key to exit..."));
      // Enable raw mode to capture a single keystroke immediately without echoing
      try {
        Deno.stdin.setRaw(true);
      } catch (_e) {
        // Fallback in case the environment is not a standard TTY
      }

      const buf = new Uint8Array(1);
      await Deno.stdin.read(buf);

      // Disable raw mode before handing control back to the shell
      try {
        Deno.stdin.setRaw(false);
      } catch (_e) {
      }

      Terminal.leaveAltScreen();
      Terminal.showCursor();

      console.log(colors.bold.cyan("\n=== Execution Summary ==="));
      console.log(colors.gray(`Total: ${total}  Success: ${successCount}  Failed: ${failedCount}  Skipped: ${skippedCount}  Offline: ${offlineCount}`));

      if (failures > 0) {
        console.log(colors.red('\nNon-success servers:'));
        serverStatuses.filter((s) => s.status !== "Success").forEach((s) => console.log(` - ${s.config.name}: ${s.status}`));
      }
    } else {
      for (const server of serverStatuses) {
        await logToFile(AXON_LOG, `  ${server.config.name}: ${server.status}`);
      }
      await logToFile(AXON_LOG, `Summary: total=${total} success=${successCount} failed=${failedCount} skipped=${skippedCount} offline=${offlineCount}`);
    }

    // Enhancement: Structured Result JSON output
    const summary = serverStatuses.map(s => ({
      server: s.config.name,
      ip: s.config.ip,
      status: s.status,
      logs: s.outputBuffer
    }));
    await Deno.writeTextFile(`${LOG_DIR}/latest_run.json`, JSON.stringify(summary, null, 2));

    Deno.exit(failures);

  } catch (error: any) {
    if (!IS_UNATTENDED) {
      Terminal.leaveAltScreen();
      Terminal.showCursor();
    }
    console.error(`\nCritical Exception: ${error.message}`);
    Deno.exit(1);
  }

  if (IS_UNATTENDED) {
    await logToFile(AXON_LOG, "Execution completed across all axons!");
  } else {
    console.log(`${colors.bold.green("Execution completed across all axons!")}`);
  }
}

Deno.addSignalListener("SIGINT", async () => {
  if (!IS_UNATTENDED) {
    Terminal.leaveAltScreen();
    Terminal.showCursor();
  }
  if (IS_UNATTENDED) {
    await logToFile(AXON_LOG, "Execution interrupted by user.");
  } else {
    console.log(colors.yellow("\nExecution interrupted by user."));
  }
  Deno.exit(1);
});

await main();