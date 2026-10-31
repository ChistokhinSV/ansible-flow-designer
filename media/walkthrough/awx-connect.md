# Connect to AWX

1. Set **`afd.awx.url`** to your AWX, e.g. `https://awx.example.net`. Turn off
   `afd.awx.verifyTls` only for a lab with a self-signed certificate.
2. Run **Ansible Flow: Set AWX Token** and paste a personal access token (Users → Tokens in AWX).
   It goes to VS Code's SecretStorage, never to a file or a setting.

_Set Up AWX Template_ then names the job template in the flow (`flow.runtime`).
