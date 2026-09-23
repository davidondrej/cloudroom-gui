---
kind: instruction
title: Room Guide — Projects
summary: Command reference for project CRUD, attachments, and sources.
intent: Provide complete project command documentation for agents.
editingNotes: Keep flags accurate against the CLI implementation.
---
Project commands

A project maps to a code repository. All threads belong to a project.

  room project list                         List ordinary projects
    --include-personal                    Also include the personal project
  room project history <id>                 List prompt history
  room project reorder <id>                 Reorder in the sidebar
    --after <id>                          Previous project, or omit for start
    --before <id>                         Next project, or omit for end
  room project create --name "..." [options]
    --root <path>                         Project source path
    --machine <id-or-name>                Bind the path to a connected machine
    --host <id-or-name>                   Alias for --machine

  An explicit machine/host selector accepts an exact ID or unambiguous name and
  binds --root to that machine. Omitting the selector preserves the existing
  local CLI machine fallback (normally the primary machine).

  room project show <id>                    Show project details
    Accepts proj_personal to inspect Personal.
  room project update <id>                  Update a project
    --name <name>                         New name

  room project delete <id>                  Delete project and all threads
    --yes                                 Skip confirmation

Discovery:

  room project branches <id> --host <id>   List branches for a machine source
  room project paths <id>                   Search workspace paths
  room project files <id>                   List workspace files
  room project content <id> <path>          Read file content (binary is base64)
  room project commands <id> --provider <id>
                                          List commands and skills
    --machine <id-or-name>                Target project source machine
    --host <id-or-name>                   Alias for --machine
    --environment <id>                    Target environment workspace

  The machine/host and environment selectors are mutually exclusive. An
  environment selects its owning machine and workspace; otherwise an explicit
  machine selects that machine's project source. Omitting both intentionally
  falls back to the primary machine's project source.

  Personal file access (`paths`, `files`, `content`) requires an explicit
  --environment <id> belonging to Personal. Personal has no default project
  source; the selected environment must be ready.

Attachments:

  room project attachment upload <id>       Upload bytes from the CLI machine
    --client-file <path>                  Path read on this CLI machine
    --filename <name>                     Attachment filename override
    --mime-type <type>                    MIME override (otherwise inferred)
  room project attachment download <id> <attachment-path>
    --client-file <path>                  Destination on this CLI machine

  Uploads use multipart bytes and return a server-managed attachment DTO. Pass
  its relative `path` to thread --file/--image input. Thread --file and --image
  upload absolute paths and file: URLs from the CLI machine automatically;
  relative values remain existing server attachment paths.
  image/* uploads are limited to 10MB; other files are limited to 25MB.
  image/heic and image/heif uploads are rejected because no renderer or
  provider can decode them; convert them to JPEG or PNG first.

Sources:

  Projects can have multiple machine-local path sources.

  room project source add <projectId>       Add a source
    --path <path>                         Local path
    --clone                               Clone the project's Git remote
    --remote-url <url>                    Git remote override for --clone
    --target-path <path>                  Destination override for --clone
    --machine <id-or-name>                Target machine (--host is an alias)
    --default                             Set as default source

  Explicit project source selectors must name a connected machine. Omitting
  the selector preserves the same local CLI machine fallback as project create.

  room project source update <projectId> <sourceId>
    --path <path>
    --default

  room project source delete <projectId> <sourceId>

Project source deletion remains available while a project is pending deletion so providers can finish cleanup. A live project must retain at least one source; a deleting project may remove its last source.

Workspace file and path searches honor Git ignore rules, including local and
global exclusions. Tracked files and non-ignored untracked files remain
searchable, including hidden files. Non-Git workspaces use filesystem listings.
Use `room file list|paths` for filesystem listings that include ignored files,
subject to their explicit exclusion options.
