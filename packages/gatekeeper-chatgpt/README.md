# ChatGPT Gatekeeper

Connects a user's ChatGPT subscription with Sign in with ChatGPT, so that models of the `chatgpt` provider run against OpenAI's Responses API on that subscription's usage limits rather than on an API key or AI Gateway credits. It is the grant pi's own `/login` → OpenAI flow obtains.

It exposes no resources to agents. The Workshop reads its access token through `ChatGptGatekeeperUser.getUsableAccessToken()` (`cloudflare-os/packages/workshop-shared/src/chatgpt-gatekeeper.ts`) for each model request.

## How it works

- `GatekeeperVendor.connectAccount()` creates a `ChatGptAccount` Durable Object and returns its connect link, `<BASE_URL>/<account id>/<nonce>`.
- The connect page starts Sign in with ChatGPT with PKCE, using the link nonce as the OAuth `state`. OpenAI registers only `http://127.0.0.1:1455/auth/callback` for this public client, so sign-in ends on a page that does not load. The user pastes that page's address into the connect page, which exchanges the code and finishes through the Workshop's connect handoff.
- The access token lives an hour. `ChatGptAccount` refreshes it with the stored refresh token one request at a time, and reports `credentialsExpired()` to the Workshop once OpenAI rejects the grant, after which the connection needs a reconnect.
- A reconnect stages the new grant until the Workshop confirms the browser that finished it, as gatekeeper-kit's `credential-stage` requires.

## Cloudflare OS changes

The `chatgpt` provider lives in the fork pinned at `cloudflare-os/`:

- `workshop-shared/src/api.ts`: the `chatgpt` provider, its suggested models, and `CONNECTED_ACCOUNT_PROVIDERS`.
- `workshop-backend/src/ai-models.ts`: `getModel()` routes `chatgpt` models to `https://api.openai.com/v1` ahead of any AI Gateway, with each request authorized by the initiating user's token. Explicit prompt-cache breakpoints, which the subscription rejects, are left out.
- `workshop-backend/src/user.ts`: `getChatGptAccessToken()`, and `chatgpt` models may be added and run on an AI Gateway deployment.
- `workshop-frontend`: the ChatGPT provider in the add-model dialog, without credential fields and with the button that starts the connection. A model's ID carries the provider (`chatgpt/gpt-6.1-sol`), since the gateway's OpenAI models use the same API IDs.

## Deploy

The starter's deploy does not build or deploy this package. Set `BASE_URL` in `wrangler.jsonc` to the Router's origin followed by `/gatekeeper/chatgpt`, then:

```sh
pnpm --dir packages/gatekeeper-chatgpt exec wrangler deploy --dry-run
pnpm --dir packages/gatekeeper-chatgpt exec wrangler deploy
```

Then bind it into the Workshop and Router through `extraGatekeepers` in `deployment.jsonc`, and redeploy the stack with the fork's changes:

```jsonc
{ "binding": "GATEKEEPER_CHATGPT", "service": "gatekeeper-chatgpt" }
```

The binding name must stay `GATEKEEPER_CHATGPT`: the Workshop finds the connection by its vendor id, `chatgpt`.

## Use

1. AI Providers → Add model → a model under ChatGPT subscription.
2. Connect ChatGPT in that dialog, follow the connect page, then add the model.

The Connectors page does not offer ChatGPT, since it lists only gatekeepers that offer resources. Once connected, the connection appears there among the connected accounts.

Requests show no cost in the Workshop: the subscription pays, under its usage limits at <https://chatgpt.com/settings/usage>.

## Limits

- Sign in with ChatGPT is meant for one person's own use of an agent. Connect only your own subscription.
- Sign in with ChatGPT tokens reach the Responses API alone, so decision models (`gpt-6-luna` as a classifier) are not offered under this provider.
- The subscription's context windows are smaller than the API's: 500K for GPT-6.1 Sol and 272K for the others.
