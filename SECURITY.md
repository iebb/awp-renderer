# Security

The CLI listens on 127.0.0.1 by default. Listening beyond loopback requires `AWP_RENDER_TOKEN`. Use TLS and an authenticated application proxy for a remote Mac; do not expose a renderer token in shipped browser code. The local playground accepts a token only in memory and does not persist it.

Pass data can contain personal information. Native jobs use disposable resource directories with restrictive file permissions, removed after each request. Captured images/layout metadata are cached in process memory for at most 60 seconds with a 16-result bound; they are not written to a persistent service log. The CLI writes files only to the output paths you choose. Successful clean exits remove job directories; a host crash or forced termination can leave a temporary job for manual removal.

Request limits and a bounded native queue protect ordinary local usage. They are not a substitute for application authentication, tenant isolation, quotas, or process isolation in a public multi-user deployment.

Do not include real pass data or secrets in a public issue. Contact the maintainer privately through the contact method on [iebb's GitHub profile](https://github.com/iebb) before publicly disclosing a vulnerability.
