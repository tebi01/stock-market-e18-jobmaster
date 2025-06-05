const { initializeQueue, getEstimationQueue } = require('../services/estimationService');
const Job = require('../models/Job');
const axios = require('axios');
const logger = require('../utils/logger');
const mongoose = require('mongoose');

mongoose.connect(process.env.MONGODB_URI)
  .then(() => logger.info('EstimationWorker conectado a MongoDB'))
  .catch(err => logger.error('Error conectando a MongoDB:', err));

async function getToken() {
  try {
      const response = await fetch(process.env.AUTH0_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          "client_id":process.env.AUTH0_CLIENT_ID,
          "client_secret":process.env.AUTH0_SECRET,
          "audience":"https://api.juanbenatuile0iic2173.me",
          "grant_type":"client_credentials"
        }),
      });

      if (!response.ok) {
          throw new Error('Network response was not ok');
      }

      const data = await response.json();
      console.log(data);
      return data.access_token;
  } catch (error) {
      console.error('Error fetching token:', error);
  }
}
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
    const token = await getToken();
    if (!token) {
      throw new Error('No se pudo obtener el token de autenticación');
    }
    logger.info(`Procesando estimación para job ${jobId} - Usuario: ${userEmail}`);
    
    // Actualizar estado a PROCESSING
    await Job.findOneAndUpdate(
      { jobId },
      { status: 'PROCESSING' }
    );
    logger.info(`Job ${jobId} actualizado a PROCESSING`);
    // PASO 1: Obtener todos los tipos de acciones del usuario y sus cantidades
    const userPortfolioResponse = await axios.get(`${process.env.MAIN_API_URL}/api/user/${userEmail}/portfolio`, {
      timeout: 10000,
      headers: {
      Authorization: `Bearer ${token}`
      }
    });
    logger.info(`Obteniendo portafolio de usuario ${userPortfolioResponse} ------------------`);
    const portfolio = userPortfolioResponse.data;
    logger.info(`Portafolio obtenido para ${userEmail}: ${JSON.stringify(portfolio)}`);
    
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
        logger.info(`Procesando acción ${symbol} con cantidad ${quantity}- paso 2`);
        // PASO 2: Obtener historial de precios para cada acción
        const historyResponse = await axios.get(`${process.env.MAIN_API_URL}/api/stocks/${symbol}/history?days=30`, {
          timeout: 10000,
          headers: {
      Authorization: `Bearer ${token}`
      }
        });
        
        const priceHistory = historyResponse.data;
        
        if (!priceHistory || priceHistory.length === 0) {
          logger.warn(`No hay historial para ${symbol}, omitiendo`);
          continue;
        }
        
        // PASO 3: Calcular función lineal
        logger.info(`Calculando estimación para ${symbol} - paso 3`);
        const estimation = calculateLinearEstimation(priceHistory);
        
        // PASO 4: Multiplicar por cantidad del usuario
        logger.info(`Calculando valor estimado para ${symbol} - paso 4`);
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
        logger.error(`Error procesando ${symbol}:`, stockError);
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
      logger.info(`Enviando callback a API principal para job ${jobId}- paso 5`);
      await axios.post(`${process.env.MAIN_API_URL}/api/estimations/callback`, {
        jobId,
        userEmail,
        estimations: result.estimations,
        summary: result.summary
      }, {
        timeout: 5000,
        headers: {
      Authorization: `Bearer ${token}`
      }
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