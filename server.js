
const moment = require('moment');
const bodyParser = require('body-parser');
require('dotenv').config();
const sql = require('mssql');
const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(bodyParser.json());


const config = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  options: {
    encrypt: true,
    trustServerCertificate: true,
  },
};


app.get('/api/db-list', async (res) => {
  try {
    const pool = await sql.connect(config);

    const result = await pool.request().query(`
      SELECT
        d.name AS [database_name],
        d.create_date AS [create_date],
        rh.restore_date AS [last_restore_date],
        rh.user_name AS [restore_user],
        d.state_desc AS [state]
      FROM master.sys.databases AS d
      LEFT JOIN msdb.dbo.restorehistory AS rh ON d.name = rh.destination_database_name
      WHERE d.name NOT IN ('master', 'tempdb', 'model', 'msdb')
      ORDER BY d.name ASC
    `);

    const databases = result.recordset.map((db) => ({
      name: db.database_name,
      createDate: moment(db.create_date).format('YYYY-MM-DD_HH-mm'),
      lastRestoreDate: moment(db.last_restore_date).format('YYYY-MM-DD_HH-mm'),
      restoreUser: db.restore_user,
      state: db.state,
    }));

    res.json(databases);
  } catch (error) {
    console.error('Error al obtener la lista de bases de datos:', error);
    res.status(500).json({ error: 'Ocurrio un error al obtener la lista de bases de datos' });
  } finally {
    sql.close();
  }
});



app.post('/api/db-online', async (req, res) => {
  const { databaseName } = req.body;

  try {
    const pool = await sql.connect(config);

    // Verificar si la base de datos existe y obtener su estado
    const checkQuery = `
      SELECT state_desc AS [state]
      FROM sys.databases
      WHERE name = '${databaseName}'
    `;
    const checkResult = await pool.request().query(checkQuery);

    if (checkResult.recordset.length === 0) {
      // La base de datos no existe
      return res.status(404).json({ error: 'Error, La base de datos no existe' });
    }

    const databaseState = checkResult.recordset[0].state;

    // Comprobar si la base de datos ya está en línea
    if (databaseState === 'ONLINE') {
      return res.status(400).json({ error: 'Error, La base de datos ya esta en linea' });
    }

    // Ejecutar la consulta para poner la base de datos en línea
    const result = await pool.request().query(`
      ALTER DATABASE ${databaseName} SET ONLINE
    `);

    res.json({ message: 'OK, Base de datos en linea' });
  } catch (error) {
    console.error('Error al poner la base de datos en línea:', error);
    res.status(500).json({ error: 'Ocurrio un error al poner la base de datos en linea' });
  } finally {
    sql.close();
  }
});


app.post('/api/db-offline', async (req, res) => {
  const { databaseName } = req.body;

  try {
    const pool = await sql.connect(config);

    // Verificar si la base de datos existe y obtener su estado
    const checkQuery = `
      SELECT state_desc AS [state]
      FROM sys.databases
      WHERE name = '${databaseName}'
    `;
    const checkResult = await pool.request().query(checkQuery);

    if (checkResult.recordset.length === 0) {
      // La base de datos no existe
      return res.status(404).json({ error: 'Error, La base de datos no existe' });
    }

    const databaseState = checkResult.recordset[0].state;

    // Comprobar si la base de datos ya está offline
    if (databaseState === 'OFFLINE') {
      return res.status(400).json({ error: 'Error, La base de datos ya esta offline' });
    }

    // Ejecutar la consulta para poner la base de datos offline
    const result = await pool.request().query(`
      ALTER DATABASE ${databaseName} SET OFFLINE
    `);

    res.json({ message: 'OK, Base de datos offline' });
  } catch (error) {
    console.error('Error al poner la base de datos offline:', error);
    res.status(500).json({ error: 'Ocurrio un error al poner la base de datos offline' });
  } finally {
    sql.close();
  }
});

  







app.post('/api/db-backup', async (req, res) => {
  const { databaseName, BackupDestinationPath } = req.body;

  try {
    // Verificar si la base de datos existe y obtener su estado
    const pool = await sql.connect(config);
    const dbStatusResult = await pool
      .request()
      .query(`
        SELECT state_desc
        FROM sys.databases
        WHERE name = '${databaseName}'
      `);

    if (dbStatusResult.recordset.length === 0) {
      res.status(404).json({ error: 'La base de datos no existe' });
      return;
    }

    const dbStatus = dbStatusResult.recordset[0].state_desc;

    // Comprobar si la base de datos está en línea
    if (dbStatus !== 'ONLINE') {
      res.status(400).json({ error: 'La base de datos debe estar en línea para realizar un backup' });
      return;
    }

    
    // Generar el nombre del archivo de backup basado en la fecha actual
    const backupDate = moment().format('YYYY-MM-DD_HH-mm');
    const backupFileName = `${databaseName}_${backupDate}.bak`;

    // Construir la consulta de backup con los parámetros adicionales
    const backupQuery = `
      BACKUP DATABASE [${databaseName}] TO DISK='${BackupDestinationPath}\\${backupFileName}' WITH COPY_ONLY, NOINIT
    `;
    await pool.request().query(backupQuery);

    res.json({ message: 'Backup de la base de datos completado exitosamente' });
  } catch (error) {
    console.error('Error al realizar el backup de la base de datos:', error);
    res.status(500).json({ error: 'Ocurrió un error al realizar el backup de la base de datos' });
  } finally {
    sql.close();
  }
});




const { exec } = require('child_process');

// Endpoint para realizar la restauración de una base de datos
app.post('/api/db-restore', async (req, res) => {
  const { databaseName, bakLocation, mdfPathDestination, ldfPathDestination } = req.body;

  try {
    const pool = await sql.connect(config);

    // Obtener la lista de archivos lógicos del respaldo
    const getFileListQuery = `
      RESTORE FILELISTONLY FROM DISK = '${bakLocation}'
    `;
    const fileListResult = await pool.request().query(getFileListQuery);

    if (fileListResult.recordset.length === 0) {
      res.status(404).json({ error: 'No se encontró información de los archivos lógicos en el archivo de respaldo' });
      return;
    }

    const dataFile = fileListResult.recordset.find((file) => file.Type === 'D');
    const logFile = fileListResult.recordset.find((file) => file.Type === 'L');

    if (!dataFile || !logFile) {
      res.status(404).json({ error: 'No se encontraron archivos lógicos válidos en el archivo de respaldo' });
      return;
    }

    const newDataLogicalName = `${databaseName}`;
    const newLogLogicalName = `${databaseName}_Log`;

    // Construir la consulta de restauración
    const restoreQuery = `
      RESTORE DATABASE [${databaseName}]
      FROM DISK = '${bakLocation}'
      WITH
      MOVE '${dataFile.LogicalName}' TO '${mdfPathDestination}${databaseName}.mdf',
      MOVE '${logFile.LogicalName}' TO '${ldfPathDestination}${databaseName}_log.ldf',
      REPLACE
    `;
    await pool.request().query(restoreQuery);

    // Cambiar el nombre lógico de los archivos restaurados
    const renameDataLogicalNameQuery = `
      ALTER DATABASE [${databaseName}] MODIFY FILE (NAME = '${dataFile.LogicalName}', NEWNAME = '${newDataLogicalName}')
    `;
    await pool.request().query(renameDataLogicalNameQuery);

    const renameLogLogicalNameQuery = `
      ALTER DATABASE [${databaseName}] MODIFY FILE (NAME = '${logFile.LogicalName}', NEWNAME = '${newLogLogicalName}')
    `;
    await pool.request().query(renameLogLogicalNameQuery);

    console.log('Restauración de la base de datos completada exitosamente');
    res.json({ message: 'Restauración de base de datos completada exitosamente' });
  } catch (error) {
    console.error('Error al realizar la restauración de la base de datos:', error);
    res.status(500).json({ error: 'Ocurrió un error al realizar la restauración de la base de datos' });
  } finally {
    sql.close();
  }
});



  
// Iniciar el servidor
app.listen(process.env.NODE_PORT, () => {
    console.log(`Servidor en funcionamiento en el puerto ${process.env.NODE_PORT}`);
  });