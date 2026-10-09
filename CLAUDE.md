# Fediscribe

Firefox extension that generates Mastodon alt texts with AI. See `PLAN.md` for goals, architecture and decisions.

## Language

- The user talks to the agent in German, but **everything in the project is written in English**: documents (README, PLAN, etc.), source code, identifiers, code comments, log messages and user interface texts.
- The language of the *generated alt texts* is a user setting and is not affected by this rule.

## UI texts

- Never hard-code UI texts. Every user-visible string goes into `_locales/en/messages.json` (with a `description` for translators) and is read via `browser.i18n.getMessage()`, or via `data-i18n` attributes in HTML. Log messages are not UI texts and stay plain English strings.
