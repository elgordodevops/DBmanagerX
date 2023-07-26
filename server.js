const moment = require('moment');
const bodyParser = require('body-parser');
require('dotenv').config();
const sql = require('mssql');
const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(bodyParser.json());
const fs = require('fs');
app.use(express.json());


// Configuración de los servidores SQL
const SQLServer1Config = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  options: {
    encrypt: true,
    trustServerCertificate: true,
  },
};

const SQLServer2Config = {
  user: process.env.DB_USER_2,
  password: process.env.DB_PASSWORD_2,
  server: process.env.DB_SERVER_2,
  database: process.env.DB_NAME_2,
  options: {
    encrypt: true,
    trustServerCertificate: true,
  },
};

const MDFLocation = process.env.MDF_PATH_DESTINATION;
const LDFLocation = process.env.LDF_PATH_DESTINATION;

const BackupDestinationPath = process.env.BACKUP_DESTINATION_PATH;


app.get('/api/db-list', async (req, res) => {
  const { server } = req.body;

  if (!server || (server !== 'server1' && server !== 'server2')) {
    return res.status(400).json({ error: 'Debe proporcionar un valor válido para el parámetro "server" (server1 o server2)' });
  }

  try {
    const config = server === 'server2' ? SQLServer2Config : SQLServer1Config;
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
    res.status(500).json({ error: 'Ocurrió un error al obtener la lista de bases de datos' });
  } finally {
    sql.close();
  }
});


app.post('/api/db-online', async (req, res) => {
  const { databaseName } = req.body;

  try {
    const pool = await sql.connect(SQLServer1Config);

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
      return res.status(400).json({ error: 'Error, La base de datos ya está en línea' });
    }

    // Ejecutar la consulta para poner la base de datos en línea
    const result = await pool.request().query(`
      ALTER DATABASE ${databaseName} SET ONLINE
    `);

    res.json({ message: 'OK, Base de datos en línea' });
  } catch (error) {
    console.error('Error al poner la base de datos en línea:', error);
    res.status(500).json({ error: 'Ocurrió un error al poner la base de datos en línea' });
  } finally {
    sql.close();
  }
});


app.post('/api/db-offline', async (req, res) => {
  const { databaseName } = req.body;

  try {
    const pool = await sql.connect(SQLServer1Config);

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
      return res.status(400).json({ error: 'Error, La base de datos ya está offline' });
    }

    // Ejecutar la consulta para poner la base de datos offline
    const result = await pool.request().query(`
      ALTER DATABASE ${databaseName} SET OFFLINE
    `);

    res.json({ message: 'OK, Base de datos offline' });
  } catch (error) {
    console.error('Error al poner la base de datos offline:', error);
    res.status(500).json({ error: 'Ocurrió un error al poner la base de datos offline' });
  } finally {
    sql.close();
  }
});


app.post('/api/db-backup', async (req, res) => {
  const { server, databaseName } = req.body;

  if (!server || (server !== 'server1' && server !== 'server2')) {
    return res.status(400).json({ error: 'Debe proporcionar un valor válido para el parámetro "server" (server1 o server2)' });
  }

  try {
    const config = server === 'server2' ? SQLServer2Config : SQLServer1Config;
    const pool = await sql.connect(config);

    // Verificar si la base de datos existe y obtener su estado
    const dbStatusResult = await pool
      .request()
      .query(`
        SELECT state_desc
        FROM sys.databases
        WHERE name = '${databaseName}'
      `);

    if (dbStatusResult.recordset.length === 0) {
      return res.status(404).json({ error: 'La base de datos no existe' });
    }

    const dbStatus = dbStatusResult.recordset[0].state_desc;

    // Comprobar si la base de datos está en línea
    if (dbStatus !== 'ONLINE') {
      return res.status(400).json({ error: 'La base de datos debe estar en línea para realizar un backup' });
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




app.post('/api/db-restore', async (req, res) => {
  const { databaseName, bakfileLocation } = req.body;

  if (!databaseName || !bakfileLocation) {
    return res.status(400).json({ error: 'Debe proporcionar los parámetros "databaseName" y "bakfileLocation"' });
  }

  try {
    const pool = await sql.connect(SQLServer1Config);

    // Verificar si la base de datos existe
    const dbExistsResult = await pool
      .request()
      .query(`
        SELECT COUNT(*) AS dbCount
        FROM sys.databases
        WHERE name = '${databaseName}'
      `);

    const dbCount = dbExistsResult.recordset[0].dbCount;

    if (dbCount > 0) {
      return res.status(400).json({ error: 'La base de datos ya existe. La restauración no puede continuar.' });
    }

    // Realizar la restauración
    const getFileListQuery = `
      RESTORE FILELISTONLY FROM DISK = '${bakfileLocation}'
    `;
    const fileListResult = await pool.request().query(getFileListQuery);

    if (fileListResult.recordset.length === 0) {
      return res.status(404).json({ error: 'No se encontró información de archivos lógicos en el archivo de copia de seguridad' });
    }

    const dataFile = fileListResult.recordset.find((file) => file.Type === 'D');
    const logFile = fileListResult.recordset.find((file) => file.Type === 'L');

    if (!dataFile || !logFile) {
      return res.status(404).json({ error: 'No se encontraron archivos lógicos válidos en el archivo de copia de seguridad' });
    }

    const newDataLogicalName = `${databaseName}`;
    const newLogLogicalName = `${databaseName}_Log`;

    const restoreQuery = `
      RESTORE DATABASE [${databaseName}]
      FROM DISK = '${bakfileLocation}'
      WITH
      MOVE '${dataFile.LogicalName}' TO '${MDFLocation}\\${databaseName}.mdf',
      MOVE '${logFile.LogicalName}' TO '${LDFLocation}\\${databaseName}_log.ldf',
      REPLACE
    `;
    await pool.request().query(restoreQuery);

    const renameDataLogicalNameQuery = `
      ALTER DATABASE [${databaseName}] MODIFY FILE (NAME = '${dataFile.LogicalName}', NEWNAME = '${newDataLogicalName}')
    `;
    await pool.request().query(renameDataLogicalNameQuery);

    const renameLogLogicalNameQuery = `
      ALTER DATABASE [${databaseName}] MODIFY FILE (NAME = '${logFile.LogicalName}', NEWNAME = '${newLogLogicalName}')
    `;
    await pool.request().query(renameLogLogicalNameQuery);

    console.log('Restauración de la base de datos completada exitosamente');
    res.json({ message: 'Restauración de la base de datos completada exitosamente' });
  } catch (error) {
    console.error('Error al realizar la restauración de la base de datos:', error);
    res.status(500).json({ error: 'Ocurrió un error al realizar la restauración de la base de datos' });
  } finally {
    sql.close();
  }
});

//###################################################################################################################







const getServerConfig = (server) => {
  return server === 'server2' ? SQLServer2Config : SQLServer1Config;
};

app.post('/api/db-backuprestore', async (req, res) => {
  const {
    sourceServer,
    destinationServer,
    sourceDatabaseName,
    destinationDatabaseName,
  } = req.body;

  try {
    const sourceConfig = getServerConfig(sourceServer);
    const destinationConfig = getServerConfig(destinationServer);

    const sourcePool = await sql.connect(sourceConfig);
    const destinationPool = await sql.connect(destinationConfig);

    // Perform the backup on the source server
    const backupDate = moment().format('YYYY-MM-DD_HH-mm');
    const backupFileName = `${sourceDatabaseName}_${backupDate}.bak`;
    const backupQuery = `
      BACKUP DATABASE [${sourceDatabaseName}] TO DISK='${BackupDestinationPath}\\${backupFileName}' WITH COPY_ONLY, NOINIT
    `;
    await sourcePool.request().query(backupQuery);

    // Perform the restore on the destination server
    const getFileListQuery = `
      RESTORE FILELISTONLY FROM DISK = '${BackupDestinationPath}\\${backupFileName}'
    `;
    const fileListResult = await sourcePool.request().query(getFileListQuery);

    if (fileListResult.recordset.length === 0) {
      res.status(404).json({ error: 'El archivo de copia de seguridad no existe en la ubicación proporcionada' });
      return;
    }

    const dataFile = fileListResult.recordset.find((file) => file.Type === 'D');
    const logFile = fileListResult.recordset.find((file) => file.Type === 'L');

    if (!dataFile || !logFile) {
      res.status(404).json({ error: 'No valid logical files found in the backup file' });
      return;
    }

    const newDataLogicalName = `${destinationDatabaseName}`;
    const newLogLogicalName = `${destinationDatabaseName}_Log`;

    const restoreQuery = `
      RESTORE DATABASE [${destinationDatabaseName}]
      FROM DISK = '${BackupDestinationPath}\\${backupFileName}'
      WITH
      MOVE '${dataFile.LogicalName}' TO '${MDFLocation}\\${destinationDatabaseName}.mdf',
      MOVE '${logFile.LogicalName}' TO '${LDFLocation}\\${destinationDatabaseName}_log.ldf',
      REPLACE
    `;
    await destinationPool.request().query(restoreQuery);

    const renameDataLogicalNameQuery = `
      ALTER DATABASE [${destinationDatabaseName}] MODIFY FILE (NAME = '${dataFile.LogicalName}', NEWNAME = '${newDataLogicalName}')
    `;
    await destinationPool.request().query(renameDataLogicalNameQuery);

    const renameLogLogicalNameQuery = `
      ALTER DATABASE [${destinationDatabaseName}] MODIFY FILE (NAME = '${logFile.LogicalName}', NEWNAME = '${newLogLogicalName}')
    `;
    await destinationPool.request().query(renameLogLogicalNameQuery);

    console.log('Backup and restore of the database completed successfully');
    res.json({ message: 'Backup and restore of the database completed successfully' });
  } catch (error) {
    console.error('Error performing backup and restore of the database:', error);
    res.status(500).json({ error: 'An error occurred while performing backup and restore of the database' });
  } finally {
    sql.close();
  }
});












const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
