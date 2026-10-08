# Provider-terms review

Reviewed October 8, 2026 against Wigwag commit `f43dc8ef5b0159502a00020e916fbfce643e6579` and the official sources
linked below. This is an implementation-based assessment, not legal advice, provider approval, or a guarantee of
compliance for every deployment. Recheck the sources when provider terms or integration interfaces change. A
negotiated agreement or organization policy may impose different requirements.

## Assessment by use

| Use | Assessment |
|---|---|
| Local development and testing with accounts the operator is authorized to use | Strongest documentary basis for the current design |
| Codex collaboration using MCP tools and the native `codex queue` command | No clear core transport violation identified; consumer output-extraction wording remains an interpretation issue |
| Claude pushes through the development-channel exception | Documented for local building and testing; broader routine or production permission is unresolved |
| Distribution to other users | Provide the privacy notice before processing personal data and follow applicable developer terms |
| OpenAI public-directory publication | Separate submission requirements and third-party-connector approval risks remain |
| Sharing or reselling subscription access, evading quotas, or bypassing safeguards | Outside the documented use of this project |

The reviewed code uses local MCP tools, Claude channel notifications, native provider CLIs, and provider hooks. It
does not implement credential harvesting, provider website/transcript scraping, private inference endpoint calls,
or modification of provider binaries. This observation is not a full security audit. Sharing task results is not
itself model training; using the results to train or distill models requires a separate terms assessment.

## Anthropic and Claude Code

The [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) (effective October 8, 2025), §3.7, permit automated
access via API keys or when Anthropic explicitly permits it. They also restrict scraping, competing products or
services, and bypassing protective measures. The [Commercial Terms](https://www.anthropic.com/legal/commercial-terms)
(effective June 17, 2025), §D.4, retain competing-product and reverse-engineering restrictions. Ordinary coordination
is not blanket authorization to offer a competing service or resell access.

Anthropic's [legal documentation](https://code.claude.com/docs/en/legal-and-compliance) assigns Consumer Terms to
Free/Pro/Max and Commercial Terms to Team/Enterprise/API users. Subscription OAuth is intended for ordinary native
Claude use; third-party developers must not collect or intermediate Claude account tokens or route subscription
requests on behalf of their users. Wigwag launches the user's installed binary and does not implement authentication.
If offering Claude Code as part of a hosted product, review the additional product-hosting conditions on that page.

The [channel documentation](https://code.claude.com/docs/en/channels) supports events that wake an existing session
and replies through MCP tools, including with subscription authentication. That is evidence supporting the automation
mechanism, not approval of Wigwag specifically. Team/Enterprise channel use requires organization enablement.

The [channel reference](https://code.claude.com/docs/en/channels-reference#test-during-the-research-preview) describes
`--dangerously-load-development-channels` for building and testing custom channels locally. It skips the channel
allowlist after an interactive confirmation, but does not override organization channel policy. The current
`wigwag claude` launcher always adds this flag. Use that launcher for genuine local channel development and testing;
do not describe the exception as established permission for general production use. An API key alone does not remove
these channel restrictions. Plain `claude` can use the installed MCP tools and hook-boundary delivery without this
launcher's development-channel opt-in. Broader push use needs an approved channel path or clarification from Anthropic.

## OpenAI and Codex

The [Terms of Use](https://openai.com/policies/terms-of-use/) (effective January 1, 2026) restrict programmatic extraction
of data or Output, account sharing, limit/safeguard circumvention, and using Output to develop competing models.
Output ownership does not override those restrictions. The [Services Agreement](https://openai.com/policies/services-agreement/)
(effective January 1, 2026), §3.3(f), permits extraction through mechanisms permitted by the Services, while §3.3
retains account/API-key and usage-limit restrictions.

OpenAI documents [MCP plugins](https://developers.openai.com/plugins) and a programmable
[app server](https://learn.chatgpt.com/docs/app-server) with turn submission, generated events, and ChatGPT authentication.
The installed Codex 0.162.0 CLI also describes `queue --thread --message` as queuing a message for an existing session.
Wigwag uses that CLI command for delivery and intentionally supplied MCP arguments for messages, not bulk harvesting
of conversation history. Treating task-specific relay as intended integration behavior is an interpretation supported
by those interfaces; no explicit exception naming Wigwag was found. API/business terms provide a clearer basis for
permitted programmatic access than the broad consumer extraction wording.

The [Service Terms](https://openai.com/policies/service-terms/) (updated September 29, 2026) supplement the applicable
agreement. They include responsibility for agent actions and appropriate oversight; code-generation output can also
carry third-party licenses. Relay through Wigwag does not remove those obligations.

## Developer and directory requirements

The [App Developer Terms](https://openai.com/policies/developer-apps-terms/) (updated September 28, 2026) explicitly
cover custom plugins and MCP integrations. §1.2 limits processing of App Requests to authorized purposes; §2.3 requires
a legally adequate notice before processing personal data. The [privacy notice](../PRIVACY.md) documents current
storage, recipients, provider disclosure, retention, and deletion. Operators remain responsible for deployment-specific
notices and permissions. Adding this notice does not certify legal adequacy for every jurisdiction or use.

The [plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines) are requirements for the public
ChatGPT/Codex directory, distinct from local installation. They require a published privacy policy and accurate MCP
tool annotations. Current tool registration omits annotations; documentation does not fix that implementation gap.
The guidelines also exclude approval of plugins primarily acting as unofficial third-party connectors or pass-through
layers. Wigwag's Claude bridge may receive that classification; shared-state features do not establish an exemption.
Directory publication therefore needs further implementation review and clarification from OpenAI.

## Operational boundaries and remaining work

- Use accounts assigned to the actual users. Do not share credentials, resell subscriptions, rotate accounts to evade
  restrictions, or use relay messages as substitutes for required owner approvals.
- Share only content authorized for every recipient and inference provider. Broker storage is local; agent context
  can leave the host. Do not send authentication secrets, protected health information, or payment-card data through
  the plugin. The implementation does not automatically redact arbitrary content.
- Keep applicable provider controls and organization policy in place. Broker wake throttling is loop protection,
  not enforcement of provider token quotas, spending, or account limits.
- Before broader Claude push use, resolve the development-channel exception's scope. Before directory submission,
  address MCP annotations, publication disclosures, and the third-party-connector classification.

Both providers' usage policies still apply to tasks and actions performed through the bus:
[OpenAI Usage Policies](https://openai.com/policies/usage-policies/) (effective October 29, 2025) and
[Anthropic Usage Policy](https://www.anthropic.com/legal/archive/22742366-2ef0-4c7a-a833-6523f10d3944)
(effective September 15, 2025). At review time, Anthropic's live usage-policy page displayed a November 12, 2026
effective date, so this assessment uses the preceding version for the review date. No assessment here authorizes
prohibited tasks or removes requirements for human oversight.
