# Production deployment

Production deploys automatically after the `CI` workflow succeeds for `main`.
GitHub Actions uploads the exact verified commit over SSH, then the server
builds the web/API applications, applies database migrations, reloads PM2 and
runs health checks.

## One-time server bootstrap

Create the database role and database:

```bash
sudo -u postgres psql
```

```sql
CREATE USER ramzes2045 WITH PASSWORD 'REPLACE_WITH_A_STRONG_PASSWORD';
CREATE DATABASE prereborn OWNER ramzes2045;
\q
```

Create the application directory and grant it to the SSH deployment user:

```bash
sudo mkdir -p /var/www/www-root/data/www/prereborn.ru
sudo chown -R www-root:www-root /var/www/www-root/data/www/prereborn.ru
```

Install Node.js 20+, Corepack, PM2 and rsync on the server. The project pins
its compatible pnpm version through `packageManager`. Confirm:

```bash
node --version
corepack pnpm --version
pm2 --version
rsync --version
```

Do not create `.env` manually. GitHub Actions assembles it from separate
protected secrets and writes it with mode `600` during every deployment.

## GitHub environment and secrets

In repository settings, create the `production` environment. Add:

- `PRODUCTION_SSH_HOST`: `91.240.85.53`
- `PRODUCTION_SSH_PORT`: SSH port, normally `22`
- `PRODUCTION_SSH_USER`: SSH login that can write to the application directory
- `PRODUCTION_SSH_PRIVATE_KEY`: private Ed25519 key used only by Actions
- `PRODUCTION_SSH_KNOWN_HOSTS`: pinned server host-key line
- `PRODUCTION_DATABASE_URL`: PostgreSQL connection string
- `PRODUCTION_STREAM_JWT_SECRET`: stream authentication signing secret
- `OPENDOTA_API_KEY`: optional OpenDota key
- `TWITCH_CLIENT_ID`: optional Twitch application ID
- `TWITCH_CLIENT_SECRET`: optional Twitch application secret

Generate the JWT value locally:

```bash
openssl rand -hex 64
```

Set `PRODUCTION_DATABASE_URL` to:

```text
postgresql://ramzes2045:REPLACE_WITH_DATABASE_PASSWORD@127.0.0.1:5432/prereborn
```

Set `PRODUCTION_STREAM_JWT_SECRET` to the generated value. Optional integration
secrets may be absent initially. Adding or rotating one secret only requires
updating that single GitHub Environment secret and rerunning the deployment.

The workflow combines secrets with stable public settings, transfers the result
over SSH without printing it and creates the runtime `.env` automatically.

Generate a dedicated deployment key locally:

```bash
ssh-keygen -t ed25519 -C "github-actions-prereborn" -f prereborn_deploy
```

Append `prereborn_deploy.pub` to the deployment user's
`~/.ssh/authorized_keys`. Put the complete private `prereborn_deploy` file in
`PRODUCTION_SSH_PRIVATE_KEY`.

Obtain the known-hosts value from a trusted machine and verify its fingerprint
against the server before saving it:

```bash
ssh-keyscan -p 22 -H 91.240.85.53
```

## First deployment

Commit and push the deployment files to `main`. CI runs first. A successful CI
run triggers `Deploy production` automatically. Follow both workflows in the
repository Actions page.

Verify:

```bash
pm2 list
curl -i http://127.0.0.1:5102/api/health
curl -I http://127.0.0.1:5100
curl -I https://prereborn.ru
```

Enable PM2 startup once:

```bash
pm2 startup
```

Run the command printed by PM2 and then:

```bash
pm2 save
```

`bash deploy.sh` remains available as an emergency manual fallback.
