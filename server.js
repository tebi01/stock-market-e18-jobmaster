require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const jobRoutes = require('./routes/jobRoutes');
const logger = require('./utils/logger');

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// Conectar a MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => logger.info('JobMaster conectado a MongoDB'))
  .catch(err => logger.error('Error conectando a MongoDB:', err));

// Health check
app.get('/heartbeat', (req, res) => {
  res.status(200).json({ 
    status: true, 
    service: 'JobMaster', 
    timestamp: new Date().toISOString() 
  });
});

// Rutas
app.use('/job', jobRoutes);

// Manejador de errores
app.use(require('./utils/errorHandler'));

const PORT = process.env.PORT || 4000;
app.listen(PORT, '0.0.0.0', () => {
  logger.info(`JobMaster corriendo en puerto ${PORT}`);
});

// Manejar errores no capturados
process.on('uncaughtException', (error) => {
  logger.error('Excepción no capturada:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Rechazo no manejado en:', promise, 'Razón:', reason);
});