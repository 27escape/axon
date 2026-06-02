#!/usr/bin/env -S deno run --allow-read --allow-env --allow-run --allow-write
// axon
/**
 * Axon: Multi-Node Parallel SSH Executor & Live Grid TUI Dashboard
 * Features tag-based routing, single-node targeting, file logging, and unattended modes.
 */

import { colors, Command, parseYaml, Secret } from "./deps.ts";

interface CommandConfig {
  name: string;
  aliases: string[];
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

interface ServerStatus {
  config: ServerConfig;
  status:
    | "Checking Keys..."
    | "Password Cached"
    | "Running"
    | "Success"
    | "Failed"
    | "Skipped";
  password?: string;
  outputBuffer: string[];
}

// Global Runtime State
let TARGET_COMMAND = "";
let TARGET_COMMAND_NAME = "";
let TARGET_SCOPE = "";
let IS_UNATTENDED = false;
let IS_VERBOSE = false;

// Dynamic Environment Variables
const USER = Deno.env.get("USER") || "default";
const HOME = Deno.env.get("HOME") || "/root";
const LOG_DIR = `/tmp/${USER}/axon`;
const AXON_LOG = "axon" 

// Ensure the log directory exists
try {
  Deno.mkdirSync(LOG_DIR, { recursive: true });
} catch (_e) {
  // Directory likely already exists
}

/**
 * Appends a formatted string with a timestamp to a server-specific log file
 */
async function logToFile(serverName: string, message: string): Promise<void> {
  const timestamp = new Date().toISOString();
  const logPath = `${LOG_DIR}/${
    serverName.replace(/[^a-zA-Z0-9_-]/g, "_")
  }.log`;
  const formattedMessage = `[${timestamp}] ${message}\n`;

  try {
    await Deno.writeTextFile(logPath, formattedMessage, { append: true });
  } catch (_e) {
    // Fail silently so file IO errors don't crash the orchestrator
  }
}

/**
 * Responsive Layout State
 */
const LAYOUT = {
  cols: 2,
  boxWidth: 55,
  boxHeight: 10,
  logRows: 6,
  startX: (col: number) => col * (LAYOUT.boxWidth + 2) + 2,
  startY: (row: number) => 4 + row * (LAYOUT.boxHeight + 1),
};

function calculateLayout(serverCount: number): void {
  try {
    const { columns, rows } = Deno.consoleSize();

    LAYOUT.cols = serverCount <= 4 ? 2 : Math.ceil(Math.sqrt(serverCount));
    const gridRows = Math.ceil(serverCount / LAYOUT.cols);

    const availableWidth = columns - 2;
    const availableHeight = rows - 4;

    LAYOUT.boxWidth = Math.floor(availableWidth / LAYOUT.cols) - 1;
    LAYOUT.boxHeight = Math.floor(availableHeight / gridRows) - 1;

    if (LAYOUT.boxWidth < 40) LAYOUT.boxWidth = 40;
    if (LAYOUT.boxHeight < 7) LAYOUT.boxHeight = 7;

    LAYOUT.logRows = LAYOUT.boxHeight - 4;
  } catch (_e) {
    // Fallback securely to default geometries
  }
}

/**
 * Bulletproof Native Terminal Controller
 */
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

async function testSshKeyAuth(server: ServerConfig): Promise<boolean> {
  const command = new Deno.Command("ssh", {
    args: [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=3",
      `${server.user}@${server.ip}`,
      "echo 'AUTH_OK'",
    ],
    stdout: "piped",
    stderr: "piped",
  });

  const { success } = await command.output();
  return success;
}

function drawStaticLayout(servers: ServerStatus[]): void {
  Terminal.clearScreen();
  Terminal.hideCursor();

  Terminal.moveTo(1, 1);
  Terminal.write(
    `${
      colors.bold.cyan("=== Axon: Parallel Command Execution Dashboard ===")
    }\n`,
  );
  Terminal.write(
    `${
      colors.gray(
        `Running [${TARGET_COMMAND_NAME}] on [${TARGET_SCOPE}]: ${TARGET_COMMAND}`,
      )
    }\n`,
  );

  servers.forEach((_, index) => {
    const col = index % LAYOUT.cols;
    const row = Math.floor(index / LAYOUT.cols);

    const startX = LAYOUT.startX(col);
    const startY = LAYOUT.startY(row);

    const horizontalBorder = "═".repeat(LAYOUT.boxWidth - 2);

    Terminal.moveTo(startX, startY);
    Terminal.write(`╔${horizontalBorder}╗`);

    Terminal.moveTo(startX, startY + LAYOUT.boxHeight - 1);
    Terminal.write(`╚${horizontalBorder}╝`);

    for (let h = 1; h < LAYOUT.boxHeight - 1; h++) {
      Terminal.moveTo(startX, startY + h);
      Terminal.write("║");
      Terminal.moveTo(startX + LAYOUT.boxWidth - 1, startY + h);
      Terminal.write("║");
    }
  });
}

function updateGridCell(server: ServerStatus, index: number): void {
  const col = index % LAYOUT.cols;
  const row = Math.floor(index / LAYOUT.cols);

  const startX = LAYOUT.startX(col) + 2;
  const startY = LAYOUT.startY(row) + 1;
  const innerWidth = LAYOUT.boxWidth - 4;

  let statusColor = colors.yellow;
  if (server.status === "Success") statusColor = colors.green;
  if (server.status === "Failed") statusColor = colors.red;
  if (server.status === "Running") statusColor = colors.cyan;
  if (server.status === "Skipped") statusColor = colors.gray;

  const headerText = `${colors.bold(server.config.name)} (${server.config.ip})`;
  const statusText = `Status: ${statusColor(server.status)}`;

  Terminal.moveTo(startX, startY);
  Terminal.write(headerText.padEnd(innerWidth));

  Terminal.moveTo(startX, startY + 1);
  Terminal.write(statusText.padEnd(innerWidth));

  Terminal.moveTo(startX, startY + 2);
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

    Terminal.moveTo(startX, startY + 3 + lineIndex);
    Terminal.write(colors.gray(cleanLine.padEnd(innerWidth)));
  });
}

/**
 * Validates that 'sshpass' is installed on the host machine.
 * Returns true if installed, false if it throws a NotFound error.
 */
async function isSshpassInstalled(): Promise<boolean> {
  try {
    const command = new Deno.Command("sshpass", {
      args: ["-V"], // Just ask for the version to see if it exists
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

async function executeSshTask(server: ServerStatus): Promise<void> {
  if (server.status === "Skipped") return;

  server.status = "Running";
  await logToFile(
    server.config.name,
    `--- Starting Command [${TARGET_COMMAND_NAME}] ---`,
  );

  let baseArgs = [
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "ConnectTimeout=10",
    `${server.config.user}@${server.config.ip}`,
    TARGET_COMMAND,
  ];

  let execBinary = "ssh";

  if (server.password) {
    execBinary = "sshpass";
    baseArgs = ["-p", server.password, "ssh", ...baseArgs];
  }

  const command = new Deno.Command(execBinary, {
    args: baseArgs,
    stdout: "piped",
    stderr: "piped",
  });

  const child = command.spawn();

  const readStream = async (
    stream: ReadableStream<Uint8Array>,
    isErrorStream: boolean,
  ) => {
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
              await logToFile(
                server.config.name,
                `${streamTag} ${line.trim()}`,
              );
            }
          }
        }
      }
    } catch (_err) {
      // Stream closed gracefully
    } finally {
      reader.releaseLock();
    }
  };

  await Promise.all([
    readStream(child.stdout, false),
    readStream(child.stderr, true),
  ]);

  const status = await child.status;
  server.status = status.success ? "Success" : "Failed";
  await logToFile(
    server.config.name,
    `--- Completion Status: ${server.status} ---`,
  );
}

async function main() {
  try {
    // 1. Initialize CLI Command Parser
    const { options, args } = await new Command()
      .name("axon")
      .description("Run commands on multiple servers")
      .arguments("<command_name:string>")
      .option(
        "-c, --config <file:string>",
        "Path to the YAML configuration file",
        { default: `${HOME}/.axon_config.yml` },
      )
      .option(
        "-t, --tag <tag:string>",
        "The server tag to target (e.g., pi, linux, mac)",
      )
      .option(
        "-s, --server <server:string>",
        "The specific server name to target",
      )
      .option(
        "-u, --unattended",
        "Run silently without TUI and skip interactive password prompts",
      )
      .option(
        "-v, --verbose",
        "Enable verbose file logging (captures full stdout/stderr)",
      )
      .parse(Deno.args);

    if (options.tag && options.server) {
      console.error(
        colors.red(
          "Error: Cannot use both --tag and --server simultaneously. Please choose one.",
        ),
      );
      Deno.exit(1);
    }

    IS_UNATTENDED = !!options.unattended;
    IS_VERBOSE = !!options.verbose;
    const requestedCommandName = args[0];
    const CONFIG_FILE = options.config;

    // 2. Load and Parse YAML Configuration
    let rawYaml;
    try {
      rawYaml = await Deno.readTextFile(CONFIG_FILE);
    } catch (_err) {
      console.error(
        colors.red(
          `Error: Could not read configuration file at ${CONFIG_FILE}`,
        ),
      );
      console.error(
        colors.yellow(
          `Please ensure the file exists or pass a valid path using -c/--config`,
        ),
      );
      Deno.exit(1);
    }

    const parsedData = parseYaml(rawYaml) as YamlConfig;

    // 3. Validate Command Availability
    let cmdConfig = parsedData.commands.find((c) =>
      c.name === requestedCommandName
    );

    if( !cmdConfig) {
      cmdConfig = parsedData.commands.find((c) =>
        c.aliases.includes(requestedCommandName)
      );
    }

    if (!cmdConfig) {
      console.error(
        colors.red(
          `Error: Command '${requestedCommandName}' not found in ${CONFIG_FILE}`,
        ),
      );
      Deno.exit(1);
    }

    TARGET_COMMAND = cmdConfig.command;
    TARGET_COMMAND_NAME = cmdConfig.name;

    let targetServers: ServerConfig[] = [];

    // 4. Resolve Target Filters
    if (options.server) {
      const server = parsedData.servers.find((s) => s.name === options.server);
      if (!server) {
        console.error(
          colors.red(
            `Error: Server '${options.server}' not found in configuration.`,
          ),
        );
        Deno.exit(1);
      }

      const hasValidTag = server.tags.some((tag) =>
        cmdConfig.tags.includes(tag)
      );
      if (!hasValidTag) {
        console.error(
          colors.red(
            `Error: Command '${requestedCommandName}' is not valid for server '${server.name}'.`,
          ),
        );
        Deno.exit(1);
      }

      TARGET_SCOPE = `Server: ${server.name}`;
      targetServers = [server];
    } else if (options.tag) {
      if (!cmdConfig.tags.includes(options.tag)) {
        console.error(
          colors.red(
            `Error: The command '${requestedCommandName}' is not valid for tag '${options.tag}'.`,
          ),
        );
        Deno.exit(1);
      }

      TARGET_SCOPE = `Tag: ${options.tag}`;
      targetServers = parsedData.servers.filter((s) =>
        s.tags.includes(options.tag!)
      );
    } else {
      TARGET_SCOPE = "All matching axons";
      targetServers = parsedData.servers.filter((s) =>
        s.tags.some((tag) => cmdConfig.tags.includes(tag))
      );
    }

    const activeServers = targetServers.filter((s) => s.active);

    if (activeServers.length === 0) {
      if (IS_UNATTENDED) {
        await logToFile(
          AXON_LOG,
          "No active servers found for the requested criteria. Task complete.",
        );
      } else {
        console.log(
          colors.yellow(
            `No active servers found for the requested criteria. Task complete.`,
          ),
        );
      }
      Deno.exit(0);
    }

    const serverStatuses: ServerStatus[] = activeServers.map((config) => ({
      config,
      status: "Checking Keys...",
      outputBuffer: ["Connection setup queue initialized."],
    }));

    // Pre-flight UI rendering
    if (!IS_UNATTENDED) {
      console.log(
        `${
          colors.bold.cyan(
            `=== Step 1: Pre-Flight Assessment for ${TARGET_SCOPE} ===`,
          )
        }`,
      );
    } else {
      await logToFile(
        AXON_LOG,
        `[Unattended Mode] Executing '${TARGET_COMMAND_NAME}' on ${TARGET_SCOPE}.`,
      );
    }

    // Step 5: Security & Connection Pre-Flight
    for (const server of serverStatuses) {
      if (!IS_UNATTENDED) {
        console.log(`Checking key configuration: ${server.config.name}...`);
      }

      const hasKey = await testSshKeyAuth(server.config);

      if (!hasKey) {
        if (IS_UNATTENDED) {
          server.status = "Skipped";
          server.outputBuffer.push("Skipped: Authentication required.");
          await logToFile(
            server.config.name,
            `--- Skipped [${TARGET_COMMAND_NAME}] ---`,
          );
          await logToFile(
            server.config.name,
            `Reason: Node requires interactive password authentication.`,
          );
        } else {
          console.log(
            `${
              colors.yellow(`⚠️  No SSH Key found for ${server.config.name}.`)
            }`,
          );
          const pwd = await Secret.prompt({
            message:
              `Enter password for ${server.config.user}@${server.config.ip}:`,
          });
          server.password = pwd;
          server.status = "Password Cached";
        }
      } else {
        server.outputBuffer.push("SSH Key verified.");
      }
    }

    const requiresSshpass = serverStatuses.some((server) =>
      server.password !== undefined
    );

    if (requiresSshpass) {
      const sshpassExists = await isSshpassInstalled();
      if (!sshpassExists) {
        console.error(
          `\n${
            colors.bold.red("Dependency Error: 'sshpass' is not installed.")
          }`,
        );
        console.error(
          colors.yellow(
            "You have nodes that require password authentication, which relies on 'sshpass'.",
          ),
        );
        console.error("Please install it using one of the following commands:");
        console.error(
          colors.gray("  Ubuntu/Debian:  sudo apt install sshpass"),
        );
        console.error(
          colors.gray("  macOS:          brew install esolitos/ipa/sshpass"),
        );
        console.error(
          colors.gray("  CentOS/RHEL:    sudo yum install sshpass\n"),
        );
        Deno.exit(1);
      }
    }

    // Step 6: TUI Initialization (Only if not unattended)
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

    // Launch background tasks
    const workers = serverStatuses.map((server) => executeSshTask(server));
    await Promise.all(workers);

    // Step 7: Teardown & Finalization
    if (!IS_UNATTENDED) {
      clearInterval(uiInterval);
      serverStatuses.forEach((server, index) => updateGridCell(server, index));
      await new Promise((resolve) => setTimeout(resolve, 3000));

      Terminal.leaveAltScreen();
      Terminal.showCursor();
    } else {
      serverStatuses.forEach((server, index) => {
        logToFile( AXON_LOG, `  ${server.config.name}: ${server.status}`);
      })
    }

  } catch (error: any) {
    if (!IS_UNATTENDED) {
      Terminal.leaveAltScreen();
      Terminal.showCursor();
    }
    console.error(`\nCritical Exception: ${error.message}`);
    Deno.exit(1);
  }

  if (IS_UNATTENDED) {
    await logToFile(
      AXON_LOG,
      "Execution completed across all axons!",
    );
  } else {
    console.log(
      `${colors.bold.green("Execution completed across all axons!")}`,
    );
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
