module.exports = {
  apps: [{
    name: 'presto',
    script: 'server/server.js',
    cwd: '/var/www/presto-pressing',
    env: { NODE_ENV: 'production', PORT: 3100 }
  }]
};
