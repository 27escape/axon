# Axon

**Axon** is a Multi-Node Parallel SSH Executor & Live Grid TUI Dashboard built with Deno. It is a much simpiler solution to managing multiple servers than Ansible, Chef or SaltStack.
It was built with the help og Google Gemini.

It is designed for homelab administrators who need to manage a cluster of Linux environments (like Raspberry Pis, Ubuntu VMs, and Mac Minis) simultaneously. Axon executes SSH commands in parallel and tracks the output in a responsive, flicker-free terminal grid interface.

It is to be run on a unix like system.


## Features
- **Parallel SSH Execution:** Run updates and commands across multiple nodes concurrently.
- **Dynamic Terminal Grid (TUI):** A custom, responsive dashboard that allocates a scrolling log window for each server.
- **Tag-Based Routing:** Define tags (e.g., `linux`, `pi`, `mac`) to strictly control which commands execute on which servers.
- **Pre-Flight Authentication:** Safely prompts for passwords if SSH key authentication is missing.
- **Unattended Mode:** Perfect for cron jobs; skips the TUI and safely aborts nodes requiring manual passwords.
- **Automated Logging:** Logs stdout/stderr to `/tmp/axon_$USER/` dynamically.

## Prerequisites

1. **Deno:** Axon requires Deno installed on your host machine.
   ``````bash
   curl -fsSL [https://deno.land/install.sh](https://deno.land/install.sh) | sh
   ```

2. sshpass (Optional but recommended): Required if any of your nodes use password authentication instead of SSH keys.

```bash
sudo apt install sshpass  # Debian/Ubuntu
brew install esolitos/ipa/sshpass # macOS
```

## Installation & Setup

Make the script executable, if it needs it:

```bash
chmod +x axon
```

Copy axon to a directory in your $PATH (e.g., /usr/local/bin) or run it directly from this folder via `./axon`.

The config file (see below) needs to be copied to your home directory

```bash
cp ~/.axon_config.yml $HOME/.axon_config.yml
```

Modify this file to your setup

### Configuration (axon_config.yml)

Axon is driven by a YAML configuration file. By default, Axon looks for this file at `~/.axon_config.yml`.

Example Configuration:
```yaml
commands:
  - name: "update"
    aliases: [ "upgrade"]
    check_command: 'check_command: test $(apt list --upgradable 2>/dev/null | wc -l) -le 1'
    command: 'sudo sh -c "apt update && apt upgrade -y && apt autoremove -y"'
    post_command: 'mqtxt /axon/status {{name}} {{server_name}} {{status}}'

- name: "ping"
    command: 'echo "pong"'
    tags: ["linux", "pi", "mac"]

- name: "brew-update"
    command: 'brew upgrade'
    tags: ["mac"]

  - name: install-nginx
    check_command: dpkg -l | grep -q nginx
    command: sudo apt-get install -y nginx
    tags: [webservers]

  - name: push-gnarlypi
    type: local
    command: '{{home}}/Repos/personal/python/gnarlypi/sync.sh {{ip}}'
    tags:
      - gnarlypi

  - name: pull-syslogs
    type: local
    command: 'scp {{user}}@{{ip}}:/var/log/syslog {{downloads}}/{{server_name}}_syslog.log'
    tags:
      - pi


servers:
  - name: "photos.local"
    ip: "192.168.0.172"
    user: "pi"
    active: true
    tags: ["pi", "linux"]
  - name: "mac-mini.local"
    ip: "192.168.0.100"
    user: "admin"
    active: true
    tags: ["mac"]
```

Note that it is possible to check if a command needs to be run, this is useful if the command may take a long time. This is the purpose of the `check_command` entry, if it returns true (0) then the command would not be actioned, otherwise it will be. For simple commands such as `ping` we do not need, or want, to use this pre-check but for system upgrades, we might.

To the command entries we can add a `type` field, if this is set to be 'local' then this allows the running of a command on the local system, for example to copy files or fetch then. Any other value will trigger a failure.

We have implemented some templates to support this and other features

- {{home}} - your home directory
- {{user}} - your login name
- {{downloads}} - local folder where fetched files can be stored, normally in `/tmp/$USER/axon/downloads`
- {{server_name}} - the name of the remote server from the config
- {{ip}} - the ip address of the remote server from the config
- {{command}} - the command that is to be run
- {{name}} - the name of the entry
- {{status}} - the status of the command that was run, will be PASSED or FAILED


## Usage

```bash
Usage: axon <command_name> [options]
Run commands on multiple servers

Options:
  -h, --help               Show this help message
  -c, --config <file>      Path to the YAML configuration file (Default: ~/.axon_config.yml)
  -t, --tag <tag>          The server tag to target (e.g., pi, linux, mac)
  -s, --server <server>    The specific server name to target (e.g., photos.local)
  -u, --unattended         Run silently without TUI and skip interactive password prompts
  -v, --verbose            Enable verbose file logging (captures full stdout/stderr)
```

## Examples
1. Run update on all eligible servers

```bash
./axon update
```

2. Target only servers tagged with pi

```bash
./axon update --tag pi
```

3. Run a command on a specific server

```bash
./axon ping -s photos.local
```

4. Run as an unattended with verbose logging to `/tmp/axon_$USER`

```bash
./axon update -u -v
```

## Troubleshooting

**Configuration Not Found:** Make sure ~/.axon_config.yml exists, or explicitly pass the path using ./axon <command> -c /path/to/axon_config.yml.

**Permission Errors:** Ensure your user has write access to /tmp/axon_$USER/ for log files.