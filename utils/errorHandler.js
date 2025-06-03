const logger = require('./logger');

const errorHandler = (err, req, res, next) => {
  logger.error('Error en JobMaster:', err);
  
  if (err.name === 'ValidationError') {
    return res.status(400).json({ error: err.message });
  }
  
  if (err.name === 'CastError') {
    return res.status(400).json({ error: 'Formato de datos inválido' });
  }
  
  if (err.statusCode) {
    return res.status(err.statusCode).json({ error: err.message });
  }
  
  res.status(500).json({ error: 'Error interno del servidor' });
};

module.exports = errorHandler;