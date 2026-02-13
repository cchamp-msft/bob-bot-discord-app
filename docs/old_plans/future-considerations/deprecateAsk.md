# Ollama Ask vs Chat Modes – Quick Reference

This project uses Ollama to run local LLMs (currently Qwen 2.5 Instruct recommended).  
Ollama provides two main ways to send prompts: **ask** and **chat**.  
They look similar but behave differently — especially important for our structured agent-style prompting.

## Summary Table

| Feature                          | `ollama ask` (or `ollama run`)                          | `ollama chat` (API `/api/chat`)                        |
|----------------------------------|----------------------------------------------------------|--------------------------------------------------------|
| **Endpoint**                     | `/api/generate`                                          | `/api/chat`                                            |
| **Message format**               | Single prompt string (no roles)                          | OpenAI-style messages array (`system`, `user`, `assistant`) |
| **Supports roles**               | No — everything is flattened into one prompt             | Yes — full system + multi-turn user/assistant history  |
| **Conversation history**         | Not preserved automatically                              | Preserved across calls (when you send previous messages) |
| **Best for our bot**             | Simple one-shot queries                                  | **Agent-style bots with history + structured context** |
| **Template compatibility**       | Works, but XML tags become plain text (less reliable)    | **Recommended** — XML tags and role separation are clean |
| **Streaming**                    | Yes                                                      | Yes                                                    |
| **Typical use in our project**   | Quick testing / debugging single prompts                 | **Main bot logic** (Discord message → full context)    |

## Recommendation for This Project

**Use `/api/chat` (ollama chat mode) for everything in the bot.**

Reasons:
- Our prompt relies on a clear `system` role + structured `user` message with XML tags (`<conversation_history>`, `<external_data>`, etc.).
- `/api/chat` keeps the roles separate → model understands boundaries better (especially Qwen 2.5).
- We need to send conversation history reliably for context continuity.
- Keyword routing and multi-turn behavior (API call → re-prompt with data) work much more cleanly.

**Do NOT use `/api/generate` (ask/run mode) for production bot logic.**

It can still be useful for:
- One-off prompt experiments in terminal
- Debugging a single isolated prompt without history

## Should We Use the Same Template?

**Yes — use the exact same XML-structured template in both modes if you test with ask.**

But:

- In `/api/chat` (recommended): send as shown in the main template (one `system` + one `user` message with XML inside).
- In `/api/generate` (for testing only): concatenate everything into a single string, e.g.:

```text
<system>
You are Bob. Rude but helpful...
</system>

<user>
<conversation_history>...</conversation_history>
<current_question>...</current_question>
...
</user>
