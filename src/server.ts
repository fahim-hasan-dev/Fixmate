import colors from 'colors';
import mongoose from 'mongoose';
import { Server } from 'socket.io';
import app from './app';
import config from './config';
import { errorLogger, logger } from './shared/logger';
import seedAdmin from './app/DB';
import { socketHelper } from './helpers/socketHelper';
import { initQueues } from './app/queues/initQueues';

process.on('uncaughtException', error => {
  errorLogger.error('UnhandledException Detected', error);
  process.exit(1);
});

let server: any;
async function main() {
  try {
    await mongoose.connect(config.database_url as string);
    logger.info(colors.green('🚀 Database connected successfully'));

    await seedAdmin();

    await initQueues();

    const port = typeof config.port === 'number' ? config.port : Number(config.port);

    server = app.listen(port, config.ip_address as string, () => {
      logger.info(colors.yellow(`♻️  Application listening on port:${config.port}`));
    });

    const io = new Server(server, {
      pingTimeout: 60000,
      cors: {
        origin: '*',
      },
    });

    logger.info(colors.green('🍁 Server connected successfully'));

    socketHelper.socket(io);

    global.io = io;
  } catch (error) {
    errorLogger.error(colors.red('Server Failed to connect Database'));
    config.node_env === 'development' && console.log(error);
  }

  process.on('unhandledRejection', error => {
    if (server) {
      server.close(() => {
        errorLogger.error('UnhandledRejection Detected', error);
        process.exit(1);
      });
    } else {
      process.exit(1);
    }
  });
}
main();

process.on('SIGTERM', async () => {
  logger.info('SIGTERM IS RECEIVE');
  if (server) {
    server.close();
  }
});
