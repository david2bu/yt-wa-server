// For running without Docker: pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
module.exports = {
  apps: [
    {
      name: 'wa-bot',
      script: 'src/index.js',
      node_args: '--disable-warning=ExperimentalWarning',
      instances: 1, // never more than one - two copies fight over the same WhatsApp session
      autorestart: true,
      restart_delay: 5000,
      max_memory_restart: '600M',
    },
  ],
}
