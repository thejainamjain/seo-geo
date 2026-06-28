module.exports = {
  apps: [
    {
      name: 'api',
      script: 'dist/app.js',
      instances: 'max',
      exec_mode: 'cluster',
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'worker',
      script: 'dist/worker.js',
      instances: 1,        // workers should NOT be clustered — BullMQ handles concurrency internally
      exec_mode: 'fork',
      env: { NODE_ENV: 'production' },
    },
  ],
};
