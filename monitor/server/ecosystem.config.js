// PM2 process config — `pm2 start ecosystem.config.js`
module.exports = {
  apps: [
    {
      name: 'cabin-monitor',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_memory_restart: '200M',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
}
