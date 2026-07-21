import { app } from './app.js';
import { config } from './config.js';

export function startServer() {
  const server = app.listen(config.port, () => {
    console.log(JSON.stringify({ message: 'server started', port: config.port }));
  });

  return server;
}
