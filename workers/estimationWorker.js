const { initializeQueue, getEstimationQueue } = require('../services/estimationService');
const Job = require('./models/Job');
const axios = require('axios');
const logger = require('../utils/logger');

// Función para calcular estimación lineal
const calculateLinearEstimation = (prices) => {
  if (!prices || prices.length < 2) {
    throw new Error('Se necesitan al menos 2 puntos de precio para estimación');
  }
  
  // Ordenar por timestamp
  prices.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  
  const firstPrice = prices[0];
  const lastPrice = prices[prices.length - 1];
  
  // Calcular diferencia en días
  const timeDiff = new Date(lastPrice.timestamp) - new Date(firstPrice.timestamp);
  const daysDiff = timeDiff / (1000 * 60 * 60 * 24);
  
  if (daysDiff === 0) {
    return {
      currentPrice: lastPrice.price,
      estimatedPrice: lastPrice.price,
      estimatedGrowth: 0,
      confidence: 'low'
    };
  }
  
  // Calcular pendiente (cambio de precio por día)
  const slope = (lastPrice.price - firstPrice.price) / daysDiff;
  
  // Proyectar precio para el próximo mes (30 días)
  const estimatedPrice = lastPrice.price + (slope * 30);
  
  // Calcular crecimiento estimado
  const estimatedGrowth = ((estimatedPrice - lastPrice.price) / lastPrice.price) * 100;
  
  return {
    currentPrice: lastPrice.price,
    estimatedPrice: Math.max(0, estimatedPrice), // No permitir precios negativos
    estimatedGrowth,
    slope,
    confidence: prices.length >= 7 ? 'high' : prices.length >= 3 ? 'medium' : 'low'
  };
};

// Procesar job de estimación
const processEstimationJob = async (job) => {
  const { jobId, userEmail } = job.data;
  
  try {
    logger.info(`Procesando estimación para job ${jobId} - Usuario: ${userEmail}`);
    
    // Actualizar estado a PROCESSING
    await Job.findOneAndUpdate(
      { jobId },
      { status: 'PROCESSING' }
    );
    
    // PASO 1: Obtener todos los tipos de acciones del usuario y sus cantidades
    const userPortfolioResponse = await axios.get(`${process.env.MAIN_API_URL}/api/user/${userEmail}/portfolio`, {
      timeout: 10000
    });
    
    const portfolio = userPortfolioResponse.data;
    
    if (!portfolio || portfolio.length === 0) {
      throw new Error(`Usuario ${userEmail} no tiene acciones en su portafolio`);
    }
    
    const estimations = [];
    let totalCurrentValue = 0;
    let totalEstimatedValue = 0;
    
    // Procesar cada tipo de acción en el portafolio
    for (const holding of portfolio) {
      const { symbol, quantity } = holding;
      
      try {
        // PASO 2: Obtener historial de precios para cada acción
        const historyResponse = await axios.get(`${process.env.MAIN_API_URL}/api/stocks/${symbol}/history?days=30`, {
          timeout: 10000
        });
        
        const priceHistory = historyResponse.data;
        
        if (!priceHistory || priceHistory.length === 0) {
          logger.warn(`No hay historial para ${symbol}, omitiendo`);
          continue;
        }
        
        // PASO 3: Calcular función lineal
        const estimation = calculateLinearEstimation(priceHistory);
        
        // PASO 4: Multiplicar por cantidad del usuario
        const currentValue = estimation.currentPrice * quantity;
        const estimatedValue = estimation.estimatedPrice * quantity;
        const estimatedGains = estimatedValue - currentValue;
        
        const stockEstimation = {
          symbol,
          quantity,
          currentPrice: estimation.currentPrice,
          estimatedPrice: estimation.estimatedPrice,
          currentValue,
          estimatedValue,
          estimatedGains,
          estimatedGrowthPercent: estimation.estimatedGrowth,
          confidence: estimation.confidence
        };
        
        estimations.push(stockEstimation);
        totalCurrentValue += currentValue;
        totalEstimatedValue += estimatedValue;
        
        logger.info(`Estimación calculada para ${symbol}: ${estimatedGains.toFixed(2)} ganancia estimada`);
        
      } catch (stockError) {
        logger.error(`Error procesando ${symbol}:`, stockError.message);
        // Continuar con la siguiente acción
      }
    }
    
    if (estimations.length === 0) {
      throw new Error('No se pudieron calcular estimaciones para ninguna acción');
    }
    
    const totalEstimatedGains = totalEstimatedValue - totalCurrentValue;
    
    const result = {
      userEmail,
      estimations, // Cada aproximación de cada acción
      summary: {
        totalCurrentValue,
        totalEstimatedValue,
        totalEstimatedGains,
        totalGrowthPercent: totalCurrentValue > 0 ? (totalEstimatedGains / totalCurrentValue) * 100 : 0,
        stocksAnalyzed: estimations.length
      },
      calculatedAt: new Date().toISOString()
    };
    
    // Actualizar job con resultado
    await Job.findOneAndUpdate(
      { jobId },
      {
        status: 'COMPLETED',
        result,
        completedAt: new Date()
      }
    );
    
    // PASO 5: Notificar a la API principal para guardar en información del cliente
    try {
      await axios.post(`${process.env.MAIN_API_URL}/api/estimations/callback`, {
        jobId,
        userEmail,
        estimations: result.estimations,
        summary: result.summary
      }, {
        timeout: 5000
      });
    } catch (callbackError) {
      logger.error('Error en callback a API principal:', callbackError.message);
      // No fallar el job por error de callback
    }
    
    logger.info(`Estimación completada para job ${jobId}: ${totalEstimatedGains.toFixed(2)} ganancia total estimada`);
    
  } catch (error) {
    logger.error(`Error procesando job ${jobId}:`, error);
    
    // Actualizar job con error
    await Job.findOneAndUpdate(
      { jobId },
      {
        status: 'FAILED',
        error: error.message,
        completedAt: new Date()
      }
    );
    
    throw error;
  }
};

// Inicializar worker
const startWorker = async () => {
  try {
    await initializeQueue();
    const queue = getEstimationQueue();
    
    // Procesar jobs
    queue.process('estimate', 1, processEstimationJob);
    
    // Event listeners
    queue.on('completed', (job) => {
      logger.info(`Job completado: ${job.data.jobId}`);
    });
    
    queue.on('failed', (job, err) => {
      logger.error(`Job fallido: ${job.data.jobId}`, err);
    });
    
    logger.info('Worker de estimación iniciado');
    
  } catch (error) {
    logger.error('Error iniciando worker:', error);
    process.exit(1);
  }
};

// Manejar cierre graceful
process.on('SIGTERM', async () => {
  logger.info('Cerrando worker...');
  const queue = getEstimationQueue();
  if (queue) {
    await queue.close();
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('Cerrando worker...');
  const queue = getEstimationQueue();
  if (queue) {
    await queue.close();
  }
  process.exit(0);
});

// Si se ejecuta directamente
if (require.main === module) {
  startWorker();
}

module.exports = {
  startWorker,
  processEstimationJob
};