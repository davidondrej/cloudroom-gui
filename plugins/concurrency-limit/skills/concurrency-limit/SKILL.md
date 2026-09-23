---
name: concurrency-limit
description: "Inspect or change global and per-host limits on concurrently running Room threads."
---

# Concurrency limits

Use `room concurrency-limit status --json` to inspect current limits.

```sh
room concurrency-limit global [unlimited|<limit>] [--json]
room concurrency-limit host <host-id> [auto|<limit>] [--json]
```

Automatic host limits allow one thread per available processor. Resolve the host
with `room machine list` before changing a host limit. Omit the value to inspect it;
change limits only for the requested scope and verify the resulting status.
