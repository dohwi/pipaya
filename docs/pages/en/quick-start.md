With the server and a client installed ([[installation]]), follow these five steps to your first conversation.

::: steps
### Connect to the server

The first time you open the app, a connection screen appears.

![The connection screen on first launch. Press (1) to connect with an address](/assets/img/ui/en/connect.png)

| Field | Value |
|---|---|
| Name | A display name (for example, Home server) |
| Server address | `http://<server address>:8787` |
| Access token | The contents of `~/.pipaya/token` on the server |

![The add-server form. Fill in (1) name, (2) server address and (3) token, then press (4) Add](/assets/img/ui/en/connect-form.png)

The app checks the connection before saving, and the token is stored only on this device. If you go over the internet with a plain `http` address, the token can be exposed, so use a Tailscale address or `https`.

### Connect a model

A new server has no models, so you must connect one before you can chat. Use the **Model connections** button on screen, or open **Settings → Model connections → Add connection**.

| Method | Description |
|---|---|
| Built-in provider | Pick it from the list, then enter an API key or sign in with your account (OAuth) |
| Local model | Pick a preset: Ollama, LM Studio, llama.cpp or vLLM |
| Custom | Enter a connection name, Base URL, model ID and API format |

See [[models]] for details.

### New chat and working folder

Press {{Alt+N}} or type `/new` to start a new chat. The **working directory** the agent will use is shown above the input; click it to change it, or use `/cd`. Check the model and reasoning strength under the input box too.

![The first screen. (1) sidebar with servers, folders and chats (2) working directory (3) input box (4) attach file (5) model and reasoning strength (6) send (7) settings](/assets/img/ui/en/home.png)

### Send a message

```text
Explain the structure of this folder
```

![A chat that used a tool. (1) the tool call (`ls`) stays folded with its result (2) the answer follows (3) model, reasoning strength, tokens and response time are shown](/assets/img/ui/en/chat.png)

The agent reads files and answers. When it tries to modify a file or run a command, an **approval card** appears. With the default policy `ask`, only actions that reach outside the working folder ask for confirmation. The full rules are in [[tools]].

### Everyday actions

| I want to | How |
|---|---|
| Stop the work | {{Escape}} or `/stop` |
| Get the answer again | `/retry` |
| Tidy a long conversation | `/compact` |
| Try another direction | `/fork` |
| Reopen a closed chat | `/resume` |
| Point at a file | Type `#` and pick one |
| Point at another session | Type `@` and pick one |
:::

## Connect a phone or another PC (QR)

You can connect without moving the token by hand.

1. On an already connected PC, open **Settings → Devices → Add phone**.
2. Make sure the address is one the phone can reach. A `localhost` address points at the phone itself, so change it to a Tailscale or LAN address.
3. Press **Create QR**, then open the app on the new device and scan it.

A code works **once, within 2 minutes**, and the QR never contains the administrator token. The new device gets its own token, which you can revoke per device later. See [[notifications]].

## Next steps

::: cards
[Composer](/en/w/composer)

[Sessions](/en/w/sessions)

[Tools and approval](/en/w/tools)

[Settings](/en/w/settings)
:::
