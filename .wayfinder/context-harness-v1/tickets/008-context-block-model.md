---
id: 008
title: Context-Block-Domänenmodell
labels: [wayfinder:grilling]
parent: context-harness-v1
status: closed
assignee: artkoenig
blocked_by: []
---

## Question

Welche Arten von Context Blocks gibt es, welche Eigenschaften (Identität, Herkunft, Pin, Token-Zahl, Rolle) haben sie, und welche Edit-Operationen (edit, move, pin, remove, compact, restore) erzeugen aus dem Session Log den Context?

## Resolution

Glossar: [CONTEXT.md](../../../CONTEXT.md) (Context Block, Revision, Tools Block, Tool Pair, Session Log, Compaction, Note, Pin).

- **Arten**: `System`, `Tools`, `User`, `Assistant`, `ToolCall`, `ToolResult`, `Note`. Compaction-Ergebnis, `@file`, freie User-Notiz (`n`) und verschobene Tool Pairs = Note mit Herkunft.
- **Tools Block**: eigener Block direkt nach System, gezählt; Tools pro Session an/aus (`ToggleTool`), nicht frei editierbar.
- **Granularität**: Assistant-Text und jeder ToolCall = eigene Blocks; Serializer fügt sie zu einer Message zusammen. Jedes ToolResult = eigener Block.
- **Identität**: stabile Block-ID; Edit = neue Revision; alte Revisionen restaurierbar.
- **Ableitung**: Session Log = Events (`BlockAdded` mit Herkunft user/model/tool; `Edit`, `Move`, `Pin`, `Unpin`, `Remove`, `Restore`, `Compact`, `ToggleTool`). Context = Fold. Undo = Gegen-Event.
- **Tool Pair**: Remove/Compact nur als Ganzes; In-place-Edit des Results behält Paar; Move (inkl. Pin) wandelt Paar in eine Note (Call verschwindet), mit Hinweis am Gate.
- **Editierbar**: alle Arten außer Tools Block und ToolCall; Edit behält Art.
- **Pin**: top = nach System+Tools; bottom = ganz ans Ende als Note (User-Rolle). Reihenfolge unter Pins umsortierbar.
- **Restore**: an ursprüngliche Position (hinter früheren Vorgänger, sonst nächsten existierenden davor). Papierkorb-Ansicht am Gate.
- **Compaction**: N Blocks → eine Note an Position des ersten; Quellen gelten als entfernt; Restore der Note = Undo. Tool Pairs nur ganz auswählbar.
- **Tokens**: pro Block gerendert inkl. Rollen-Marker; Template-Overhead (BOS, Generation-Prompt) als eigene Zeile „Template“. Summe = exakte Request-Größe.
- **Gate-Zeile** (Input für Review-Gate-UI): Art, Kurztitel, Tokens, Flags `✎`(+Revisionen) `📌` `⇄` `◇`; Enter → Detail (Herkunft, Revisionen).
