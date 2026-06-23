#!/usr/bin/env -S deno run --allow-net --allow-sys --allow-env
// axon_tui
/**
 * Axon TUI: Event-Driven Terminal User Interface for Axon Daemon
 * Connects via MQTT to visualize parallel SSH deployments in real-time.
 * Features Double-Buffered I/O, Layout Caching, and Continuous Dashboarding.
 */

const VERSION = "7.3.0";

import { colors } from "./deps.ts";
import mqtt from "npm:mqtt@^5.5.0";

interface ServerConfig { name: string; ip: string; }
interface ServerStatus {
  config: ServerConfig;
  status: string;
  currentPhase: string;
  outputBuffer: string[];
}

// === Local UI State ===
let LOCAL_STATE: ServerStatus[] = [];
let IS_DRY_RUN = false;
let IS_FORCED = false;
let IS_COMPLETED = false;
let FINAL_SUMMARY: any = null;
let ACTIVE_RUN_ID: string | null = null;
let IS_LAYOUT_DRAWN = false;

const MQTT_BROKER = Deno.env.get("MQTT_BROKER") || "mqtt://127.0.0.1:1883";

// === Double-Buffered Terminal I/O ===
let writeBuffer = "";
const Terminal = {
  encoder: new TextEncoder(),
  buffer: (text: string) => { writeBuffer += text; },
  flush: () => {
    if (writeBuffer.length > 0) {
      Deno.stdout.writeSync(Terminal.encoder.encode(writeBuffer));
      writeBuffer = "";
    }
  },
  write: (text: string) => Terminal.buffer(text),
  enterAltScreen: () => { Terminal.buffer("\x1b[?1049h"); Terminal.flush(); },
  leaveAltScreen: () => { Terminal.buffer("\x1b[?1049l"); Terminal.flush(); },
  hideCursor: () => { Terminal.buffer("\x1b[?25l"); Terminal.flush(); },
  showCursor: () => { Terminal.buffer("\x1b[?25h"); Terminal.flush(); },
  clearScreen: () => Terminal.buffer("\x1b[2J"),
  moveTo: (x: number, y: number) => Terminal.buffer(`\x1b[${y};${x}H`),
};

const LAYOUT = {
  cols: 2, boxWidth: 55, boxHeight: 10, logRows: 6,
  startX: (col: number) => col * (LAYOUT.boxWidth - 1) + 1,
  startY: (row: number) => 1 + row * (LAYOUT.boxHeight - 1),
};

function calculateLayout(serverCount: number): void {
  try {
    const { columns, rows } = Deno.consoleSize();
    if (serverCount === 1) {
      LAYOUT.cols = 1; LAYOUT.boxWidth = columns; LAYOUT.boxHeight = rows; LAYOUT.logRows = rows - 4;
    } else {
      LAYOUT.cols = Math.ceil(Math.sqrt(serverCount));
      const gridRows = Math.ceil(serverCount / LAYOUT.cols);
      LAYOUT.boxWidth = Math.max(40, Math.floor((columns - 2 + (LAYOUT.cols - 1)) / LAYOUT.cols));
      LAYOUT.boxHeight = Math.max(7, Math.floor((rows + (gridRows - 1)) / gridRows));
      LAYOUT.logRows = Math.max(0, LAYOUT.boxHeight - 4);
    }
  } catch (_e) {}
}

function drawStaticLayout(): void {
  Terminal.clearScreen();
  const cols = LAYOUT.cols;
  const rows = Math.ceil(LOCAL_STATE.length / cols);
  const innerW = LAYOUT.boxWidth - 2;

  let titleLine = IS_DRY_RUN ? colors.bgYellow.black(`  *** DRY RUN MODE ACTIVE *** `) : "";
  if (IS_FORCED) titleLine += colors.bgRed.white(`  *** FORCE MODE ACTIVE *** `);
  
  if (titleLine) { Terminal.moveTo(1, 1); Terminal.write(titleLine); }

  const yOffset = (IS_DRY_RUN || IS_FORCED) ? 1 : 0;

  for (let r = 0; r < rows; r++) {
    const topY = LAYOUT.startY(r) + yOffset;
    let topLine = "";
    for (let c = 0; c < cols; c++) topLine += (c === 0 ? "╔" : "╦") + "═".repeat(innerW);
    Terminal.moveTo(1, topY); Terminal.write(topLine + "╗");

    for (let h = 1; h < LAYOUT.boxHeight - 1; h++) {
      let midLine = "";
      for (let c = 0; c < cols; c++) midLine += "║" + " ".repeat(innerW);
      Terminal.moveTo(1, topY + h); Terminal.write(midLine + "║");
    }

    let bottomLine = "";
    for (let c = 0; c < cols; c++) bottomLine += (c === 0 ? "╚" : "╩") + "═".repeat(innerW);
    Terminal.moveTo(1, topY + LAYOUT.boxHeight - 1); Terminal.write(bottomLine + "╝");
  }
}

function updateGridCell(index: number): void {
  if (!LOCAL_STATE[index]) return;
  const server = LOCAL_STATE[index];
  const col = index % LAYOUT.cols, row = Math.floor(index / LAYOUT.cols);
  const yOffset = (IS_DRY_RUN || IS_FORCED) ? 1 : 0;
  const startX = LAYOUT.startX(col) + 1, startY = LAYOUT.startY(row) + 1 + yOffset;
  const innerW = LAYOUT.boxWidth - 2;

  const colorMap: Record<string, Function> = { "Success": colors.green, "Failed": colors.red, "Skipped": colors.gray, "Offline": colors.red, "Aborted": colors.magenta, "Timeout": colors.red };
  const phaseText = server.status in colorMap && server.status !== "Success" ? server.status : server.currentPhase;
  const statusColor = colorMap[server.status] || colors.yellow;
  
  let header = `${colors.bold(server.config.name)} (${server.config.ip}) ${statusColor(phaseText)}`;
  if (header.length > innerW) header = header.substring(0, innerW - 3) + "...";
  
  Terminal.moveTo(startX, startY); Terminal.write(header.padEnd(innerW));
  Terminal.moveTo(startX, startY + 1); Terminal.write("─".repeat(innerW));

  const logsToDisplay = [...server.outputBuffer.slice(-LAYOUT.logRows), ...Array(LAYOUT.logRows).fill("")].slice(0, LAYOUT.logRows);
  logsToDisplay.forEach((line, i) => {
    let clean = line.replace(/\t/g, "    ").trim();
    if (clean.length > innerW) clean = clean.substring(0, innerW - 3) + "...";
    // padEnd ensures old longer log lines are safely overwritten with whitespace
    Terminal.moveTo(startX, startY + 2 + i); Terminal.write(colors.gray(clean.padEnd(innerW)));
  });
}

function drawCompletionMessage(): void {
  if (LOCAL_STATE.length === 0) return;
  const yOffset = (IS_DRY_RUN || IS_FORCED) ? 1 : 0;
  const totalRows = Math.ceil(LOCAL_STATE.length / LAYOUT.cols);
  const bottomY = LAYOUT.startY(totalRows - 1) + LAYOUT.boxHeight + yOffset + 1;
  Terminal.moveTo(1, bottomY);
  Terminal.write(colors.bold.cyan("Deployment Completed - Waiting for next run (Ctrl+C to exit)...") + " ".repeat(10));
}

function handleResize(): void {
  if (LOCAL_STATE.length === 0 || !ACTIVE_RUN_ID) return;
  calculateLayout(LOCAL_STATE.length);
  Terminal.clearScreen();
  drawStaticLayout();
  LOCAL_STATE.forEach((_, i) => updateGridCell(i));
  if (IS_COMPLETED) drawCompletionMessage();
  Terminal.flush(); // Render entire resized frame atomically
}

try { Deno.addSignalListener("SIGWINCH", handleResize); } catch (_e) {}

async function gracefulExit(exitCode: number) {
  if (ACTIVE_RUN_ID) {
    Terminal.leaveAltScreen();
    Terminal.showCursor();
  }

  if (FINAL_SUMMARY) {
    console.log(colors.bold.cyan("\n=== Last Execution Summary ==="));
    if (FINAL_SUMMARY.reason === "SIGINT") console.log(colors.bgRed.white(" *** EXECUTION ABORTED BY USER *** "));
    if (FINAL_SUMMARY.reason === "Global Timeout") console.log(colors.bgRed.white(" *** EXECUTION TIMED OUT *** "));
    
    console.log(`\nTotal Targets: ${FINAL_SUMMARY.totalTargets}`);
    console.log(`Success:       ${colors.green(FINAL_SUMMARY.success.toString())}`);
    console.log(`Skipped:       ${colors.gray(FINAL_SUMMARY.skipped.toString())}`);
    console.log(`Failures:      ${FINAL_SUMMARY.failures > 0 ? colors.red(FINAL_SUMMARY.failures.toString()) : "0"}`);

    if (FINAL_SUMMARY.failures > 0) {
      console.log(colors.red('\nNon-success servers:'));
      FINAL_SUMMARY.failedServers.forEach((s: any) => {
        const outColor = (s.status === "Aborted" || s.status === "Timeout") ? colors.magenta : colors.red;
        console.log(` - ${colors.bold(s.name)}: ${outColor(s.status)}`);
      });
    }
    console.log(colors.cyan(`\nPersistent Audit Log: ${FINAL_SUMMARY.runLogPath}`));
  }
  Deno.exit(exitCode);
}

Deno.addSignalListener("SIGINT", () => {
  gracefulExit(0);
});

async function main() {
  console.log(colors.cyan(`Connecting to MQTT Broker at ${MQTT_BROKER} ...`));
  const client = mqtt.connect(MQTT_BROKER);

  client.on('connect', () => {
    console.log(colors.green(`✓ Connected. Searching for active deployments...`));
    client.subscribe('axon/runs/latest');
  });

  client.on('message', async (topic, message) => {
    const payload = message.toString();

    // === Step 1: Continuous Auto-Discovery ===
    if (topic === 'axon/runs/latest') {
      const data = JSON.parse(payload);
      
      if (ACTIVE_RUN_ID === data.run_id) return; 
      
      if (ACTIVE_RUN_ID) {
        client.unsubscribe(`axon/run/${ACTIVE_RUN_ID}/state`);
        client.unsubscribe(`axon/run/${ACTIVE_RUN_ID}/status`);
      }
      
      ACTIVE_RUN_ID = data.run_id;
      IS_COMPLETED = false;
      FINAL_SUMMARY = null;
      LOCAL_STATE = []; 
      IS_LAYOUT_DRAWN = false; // Reset Layout Cache
      
      Terminal.enterAltScreen();
      Terminal.hideCursor();
      Terminal.clearScreen();
      Terminal.flush(); // Clear screen immediately
      
      client.subscribe(`axon/run/${ACTIVE_RUN_ID}/state`);
      client.subscribe(`axon/run/${ACTIVE_RUN_ID}/status`);
      return;
    }

    // === Step 2: Grid State Parsing ===
    if (ACTIVE_RUN_ID && topic === `axon/run/${ACTIVE_RUN_ID}/state`) {
      const data = JSON.parse(payload);
      LOCAL_STATE = data.state;
      IS_DRY_RUN = data.isDryRun;
      IS_FORCED = data.isForced;
      
      calculateLayout(LOCAL_STATE.length);

      // Layout Caching: Only draw the heavy borders if they haven't been drawn yet
      if (!IS_LAYOUT_DRAWN) {
        drawStaticLayout();
        IS_LAYOUT_DRAWN = true;
      }

      LOCAL_STATE.forEach((_, i) => updateGridCell(i));
      Terminal.flush(); // Render all cell updates atomically
    }

    // === Step 3: Lifecycle Finalisation ===
    if (ACTIVE_RUN_ID && topic === `axon/run/${ACTIVE_RUN_ID}/status`) {
      const data = JSON.parse(payload);
      if (data.status === "completed") {
        IS_COMPLETED = true;
        FINAL_SUMMARY = data;
        drawCompletionMessage();
        Terminal.flush(); // Render final text
      }
    }
  });

  client.on('error', (err) => {
    console.error(colors.red(`\nMQTT Connection Error: ${err.message}`));
  });
}

await main();