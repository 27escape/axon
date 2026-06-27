#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env
// axon_web.ts
/**
 * Axon Web: REST API & Static HTTP Server for the Control Plane.
 * Features Hot-Reload (SSE), Bidirectional Config Sync, and Delegated MQTT Auth.
 */

import { serveDir } from "https://deno.land/std@0.224.0/http/file_server.ts";
import { parse as parseYaml, stringify as stringifyYaml } from "https://deno.land/std@0.224.0/yaml/mod.ts";
import { decodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";
import mqtt from "npm:mqtt@^5.5.0";
import { colors } from "./deps.ts";

const PORT = 8000;
const HOME = Deno.env.get("HOME") || "/root";
const CONFIG_PATH = Deno.env.get("AXON_CONFIG") || `${HOME}/.axon_config.yml`;
const MQTT_BROKER = Deno.env.get("MQTT_BROKER_INTERNAL") || "mqtt://127.0.0.1:8884";

const connectedClients = new Set<ReadableStreamDefaultController>();

// --- Security: Delegated MQTT Authentication ---
async function authenticate(req: Request): Promise<{ user: string; pass: string } | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Basic ")) return null;

  try {
    const b64 = authHeader.split(" ")[1];
    const decoded = new TextDecoder().decode(decodeBase64(b64));
    const [user, pass] = decoded.split(":");

    // Delegate verification to Mosquitto
    const isValid = await new Promise<boolean>((resolve) => {
      const tempClient = mqtt.connect(MQTT_BROKER, { username: user, password: pass, connectTimeout: 2000, reconnectPeriod: 0 });
      tempClient.on('connect', () => { tempClient.end(true); resolve(true); });
      tempClient.on('error', () => { tempClient.end(true); resolve(false); });
    });

    return isValid ? { user, pass } : null;
  } catch (_e) {
    return null;
  }
}

// Watch the public directory for changes and broadcast to browsers
async function watchFiles() {
  try {
    const watcher = Deno.watchFs("./public");
    for await (const event of watcher) {
      if (event.kind === "modify") {
        console.log(colors.yellow(`\n[Live Reload] Detected change in UI files. Pushing to clients...`));
        for (const client of connectedClients) {
          try { client.enqueue(new TextEncoder().encode("data: reload\n\n")); } 
          catch (_e) { connectedClients.delete(client); }
        }
      }
    }
  } catch (e: any) {
    console.error(colors.red(`[File Watcher] Failed to watch ./public: ${e.message}`));
  }
}

watchFiles();

Deno.serve({ port: PORT, onListen: ({ port }) => {
  console.log(colors.green(`\n🚀 Axon Web Control Plane running!`));
  console.log(colors.cyan(`Maps to: http://localhost:${port}`));
  console.log(colors.gray(`Managing configuration at: ${CONFIG_PATH}\n`));
}}, async (req) => {
  const url = new URL(req.url);

  // --- API: Read Configuration ---
  if (url.pathname === "/api/config" && req.method === "GET") {
    const auth = await authenticate(req);
    if (!auth) return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Axon"' } });

    try {
      const yamlText = await Deno.readTextFile(CONFIG_PATH);
      const data = parseYaml(yamlText);
      console.log(colors.blue(`[API] Config requested by ${auth.user}`));
      return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: `Failed to read config: ${e.message}` }), { status: 500 });
    }
  }

  // --- API: Update Configuration ---
  if (url.pathname === "/api/config" && req.method === "POST") {
    const auth = await authenticate(req);
    if (!auth) return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Axon"' } });
    
    // RBAC: Only Admin can write config changes
    if (auth.user !== "axon_admin") {
      console.warn(colors.red(`[SECURITY] Config write blocked for user: ${auth.user}`));
      return new Response("Forbidden: Requires Admin privileges.", { status: 403 });
    }

    try {
      const payload = await req.json();
      if (!payload || typeof payload !== "object" || !Array.isArray(payload.commands) || !Array.isArray(payload.servers)) {
        return new Response(JSON.stringify({ error: "Invalid Schema" }), { status: 400 });
      }

      const yamlOutput = stringifyYaml(payload);
      await Deno.writeTextFile(CONFIG_PATH, yamlOutput);
      
      console.log(colors.green(`[API] Configuration updated by ${auth.user}.`));
      return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: `Failed to write config: ${e.message}` }), { status: 500 });
    }
  }

  // --- Live Reload Endpoint ---
  if (url.pathname === "/live-reload") {
    let controller: ReadableStreamDefaultController;
    const body = new ReadableStream({
      start(c) { controller = c; connectedClients.add(c); },
      cancel() { connectedClients.delete(controller); }
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" } });
  }

  // --- Static File Server ---
  return serveDir(req, {
    fsRoot: "public",
    urlRoot: "",
    showDirListing: true,
    enableCors: true,
  });
});