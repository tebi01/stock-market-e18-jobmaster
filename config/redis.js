const Redis = require('redis');
const logger = require('../utils/logger');

let redisClient;

const connectRedis = async () => {
  try {
    redisClient = Redis.createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379'
    });

    redisClient.on('error', (err) => {
      logger.error('Error de Redis:', err);
    });

    redisClient.on('connect', () => {
      logger.info('Conectado a Redis');
    });

    await redisClient.connect();
    return redisClient;
  } catch (error) {
    logger.error('Error conectando a Redis:', error);
    throw error;
  }
};

const getRedisClient = () => {
  if (!redisClient) {
    throw new Error('Redis no está conectado');
  }
  return redisClient;
};

module.exports = {
  connectRedis,
  getRedisClient
};