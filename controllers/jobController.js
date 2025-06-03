const Job = require('../models/job');
const { createEstimationJob } = require('../services/estimationService');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

// Crear nuevo job
const createJob = async (req, res) => {
  try {
    const { type, data } = req.body;
    
    if (!type || !data) {
      return res.status(400).json({ error: 'Tipo y datos son requeridos' });
    }
    
    if (type !== 'ESTIMATE_GAINS') {
      return res.status(400).json({ error: 'Tipo de job no soportado' });
    }
    
    // Validar datos requeridos para estimación
    if (!data.userEmail) {
      return res.status(400).json({ error: 'userEmail es requerido' });
    }
    
    const jobId = uuidv4();
    
    // Crear job en BD
    const job = new Job({
      jobId,
      type,
      data,
      status: 'PENDING'
    });
    
    await job.save();
    
    // Encolar job para procesamiento
    await createEstimationJob(jobId, data);
    
    res.status(201).json({
      jobId,
      status: 'PENDING',
      message: 'Job creado exitosamente'
    });
    
    logger.info(`Job creado: ${jobId} para usuario ${data.userEmail}`);
  } catch (error) {
    logger.error('Error creando job:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// Obtener estado de job
const getJob = async (req, res) => {
  try {
    const { id } = req.params;
    
    const job = await Job.findOne({ jobId: id });
    
    if (!job) {
      return res.status(404).json({ error: 'Job no encontrado' });
    }
    
    res.json({
      jobId: job.jobId,
      status: job.status,
      result: job.result,
      error: job.error,
      createdAt: job.createdAt,
      completedAt: job.completedAt
    });
  } catch (error) {
    logger.error('Error obteniendo job:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

module.exports = {
  createJob,
  getJob
};