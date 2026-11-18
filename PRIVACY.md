# Privacy — Groundwork by Stackrift

**Short version:** Groundwork runs on your machine. Stackrift receives no data from it.

## What Groundwork stores

Groundwork writes its working files into your own repository, under `.groundwork/` and
`openspec/`. Some of them hold personal data that already exists in your tools:

- the author names on ticket comments, in the ticket copy it saves (`source.json`);
- the logins of pull request commenters, in the review rounds it records;
- the author names of recent commits, in the history summary (`history.md`).

When you approve a delivery, the change's own record under `.groundwork/changes/<change>/`
is committed with the code, so these files reach your code host with the pull request,
like the rest of your repository. Generated agent inputs, test logs and the local
approval pages are not committed. The files stay until you delete them.

## Where data goes

Groundwork sends data only to services you set up and sign in to yourself:

- your issue tracker, through the MCP server you name in the config, to read tickets
  and to post the comments you approve word for word;
- your code host, through `gh` or `az`, to push branches and manage pull requests;
- the reference pages you pass with `--ref`, fetched only from the domains you list in
  `context.trustedDomains`.

Your use of Claude itself is covered by Anthropic's terms and privacy policy.

## What Stackrift receives

Nothing. Groundwork has no server, no analytics and no telemetry.

## Contact

consulting@stackrift.io
