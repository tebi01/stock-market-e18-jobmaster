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

// Función para interpolación lineal entre dos puntos
const interpolateLinear = (x1, y1, x2, y2, x) => {
  if (x2 === x1) return y1;
  return y1 + ((y2 - y1) * (x - x1)) / (x2 - x1);
};

// Función para generar 100 puntos mediante interpolación
const generateInterpolatedData = (prices, targetPoints = 100) => {
  if (!prices || prices.length === 0) {
    throw new Error('No hay datos de precios para interpolar');
  }

  // Ordenar por timestamp
  const sortedPrices = [...prices].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  
  if (sortedPrices.length === 1) {
    // Si solo hay un punto, generar 100 puntos con el mismo precio
    const singlePrice = sortedPrices[0];
    const now = new Date();
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    
    return Array.from({ length: targetPoints }, (_, i) => {
      const timestamp = new Date(monthAgo.getTime() + (i * 30 * 24 * 60 * 60 * 1000) / (targetPoints - 1));
      return {
        timestamp: timestamp.toISOString(),
        price: singlePrice.price
      };
    });
  }

  const firstPoint = sortedPrices[0];
  const lastPoint = sortedPrices[sortedPrices.length - 1];
  const startTime = new Date(firstPoint.timestamp).getTime();
  const endTime = new Date(lastPoint.timestamp).getTime();
  const timeRange = endTime - startTime;

  const interpolatedData = [];

  for (let i = 0; i < targetPoints; i++) {
    // Calcular el tiempo para este punto
    const targetTime = startTime + (timeRange * i) / (targetPoints - 1);
    const targetDate = new Date(targetTime);

    // Encontrar los dos puntos más cercanos en los datos originales
    let leftIndex = 0;
    let rightIndex = sortedPrices.length - 1;

    for (let j = 0; j < sortedPrices.length - 1; j++) {
      const currentTime = new Date(sortedPrices[j].timestamp).getTime();
      const nextTime = new Date(sortedPrices[j + 1].timestamp).getTime();
      
      if (targetTime >= currentTime && targetTime <= nextTime) {
        leftIndex = j;
        rightIndex = j + 1;
        break;
      }
    }

    // Interpolar el precio
    const leftPoint = sortedPrices[leftIndex];
    const rightPoint = sortedPrices[rightIndex];
    const leftTime = new Date(leftPoint.timestamp).getTime();
    const rightTime = new Date(rightPoint.timestamp).getTime();
    
    let interpolatedPrice;
    if (leftTime === rightTime) {
      interpolatedPrice = leftPoint.price;
    } else {
      interpolatedPrice = interpolateLinear(
        leftTime, leftPoint.price,
        rightTime, rightPoint.price,
        targetTime
      );
    }

    interpolatedData.push({
      timestamp: targetDate.toISOString(),
      price: interpolatedPrice
    });
  }

  return interpolatedData;
};

// Función para calcular regresión lineal
const calculateLinearRegression = (data) => {
  const n = data.length;
  if (n < 2) {
    throw new Error('Se necesitan al menos 2 puntos para regresión lineal');
  }

  // Convertir timestamps a números (días desde el primer punto)
  const startTime = new Date(data[0].timestamp).getTime();
  const points = data.map(point => ({
    x: (new Date(point.timestamp).getTime() - startTime) / (1000 * 60 * 60 * 24), // días
    y: point.price
  }));

  // Calcular sumas necesarias para regresión lineal
  const sumX = points.reduce((sum, point) => sum + point.x, 0);
  const sumY = points.reduce((sum, point) => sum + point.y, 0);
  const sumXY = points.reduce((sum, point) => sum + point.x * point.y, 0);
  const sumXX = points.reduce((sum, point) => sum + point.x * point.x, 0);

  // Calcular pendiente (slope) y ordenada al origen (intercept)
  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;

  // Calcular coeficiente de correlación (R²)
  const meanY = sumY / n;
  const totalSumSquares = points.reduce((sum, point) => sum + Math.pow(point.y - meanY, 2), 0);
  const residualSumSquares = points.reduce((sum, point) => {
    const predictedY = slope * point.x + intercept;
    return sum + Math.pow(point.y - predictedY, 2);
  }, 0);
  
  const rSquared = totalSumSquares === 0 ? 1 : 1 - (residualSumSquares / totalSumSquares);

  return {
    slope,
    intercept,
    rSquared,
    points
  };
};

// Función para calcular estimación con regresión lineal
const calculateRegressionEstimation = (prices) => {
  if (!prices || prices.length < 2) {
    throw new Error('Se necesitan al menos 2 puntos de precio para estimación');
  }

  // Generar 100 puntos interpolados
  const interpolatedData = generateInterpolatedData(prices, 100);
  
  // Calcular regresión lineal
  const regression = calculateLinearRegression(interpolatedData);
  
  // Obtener el precio actual (último punto)
  const lastPoint = interpolatedData[interpolatedData.length - 1];
  const currentPrice = lastPoint.price;
  
  // Calcular el tiempo del último punto en días desde el inicio
  const startTime = new Date(interpolatedData[0].timestamp).getTime();
  const lastTime = new Date(lastPoint.timestamp).getTime();
  const daysSinceStart = (lastTime - startTime) / (1000 * 60 * 60 * 24);
  
  // Proyectar precio para 30 días después del último punto
  const futureDays = daysSinceStart + 30;
  const estimatedPrice = regression.slope * futureDays + regression.intercept;
  
  // Calcular crecimiento estimado
  const estimatedGrowth = ((estimatedPrice - currentPrice) / currentPrice) * 100;
  
  // Determinar confianza basada en R² y cantidad de datos originales
  let confidence = 'low';
  if (regression.rSquared > 0.8 && prices.length >= 10) {
    confidence = 'high';
  } else if (regression.rSquared > 0.6 && prices.length >= 5) {
    confidence = 'medium';
  }

  return {
    currentPrice,
    estimatedPrice: Math.max(0, estimatedPrice), // No permitir precios negativos
    estimatedGrowth,
    slope: regression.slope,
    intercept: regression.intercept,
    rSquared: regression.rSquared,
    confidence,
    interpolatedPoints: interpolatedData.length,
    originalDataPoints: prices.length
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
        
        // PASO 3: Calcular función lineal (ahora usando regresión con interpolación)
        logger.info(`Calculando estimación para ${symbol} - paso 3`);
        const estimation = calculateRegressionEstimation(priceHistory);
        
        // PASO 4: Multiplicar por cantidad del usuario
        logger.info(`Calculando valor estimado para ${symbol} - paso 4`);
        const currentValue = estimation.currentPrice * quantity;
        const estimatedValue = estimation.estimatedPrice * quantity;
        const estimatedGains = estimatedValue - currentValue;
        
        // Debug logs
        logger.info(`Debug ${symbol}: currentPrice=${estimation.currentPrice}, estimatedPrice=${estimation.estimatedPrice}, quantity=${quantity}`);
        logger.info(`Debug ${symbol}: currentValue=${currentValue}, estimatedValue=${estimatedValue}, estimatedGains=${estimatedGains}`);
        
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
        
        logger.info(`Debug totales: totalCurrentValue=${totalCurrentValue}, totalEstimatedValue=${totalEstimatedValue}`);
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
    
    // Debug logs para el resumen
    logger.info(`Debug resumen final: totalCurrentValue=${totalCurrentValue}, totalEstimatedValue=${totalEstimatedValue}, totalEstimatedGains=${totalEstimatedGains}`);
    
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
    
    logger.info(`Debug result.summary: ${JSON.stringify(result.summary)}`);
    
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