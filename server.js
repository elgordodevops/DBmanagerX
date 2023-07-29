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
const axios = require('axios');



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



app.post('/api/db-list', async (req, res) => {
  const { server } = req.body; // Obtener el valor de "server" desde el cuerpo de la solicitud

  if (!server || (server !== 'server1' && server !== 'server2')) {
    return res.status(400).json({ error: 'Debe proporcionar un valor válido para el parámetro "server" (server1 o server2)' });
  }

  try {
    const config = server === 'server2' ? SQLServer2Config : SQLServer1Config;
    const pool = await sql.connect(config);

    const result = await pool.request().query(`
    SELECT
    [database_name],
    CONVERT(varchar, [create_date], 120) AS [create_date],
    CONVERT(varchar, [last_restore_date], 120) AS [last_restore_date],
    [restore_user],
    [state]
FROM
    (
        SELECT
            d.name AS [database_name],
            d.create_date AS [create_date],
            rh.restore_date AS [last_restore_date],
            rh.user_name AS [restore_user],
            d.state_desc AS [state],
            ROW_NUMBER() OVER (PARTITION BY d.name ORDER BY rh.restore_date DESC) AS [rn]
        FROM
            master.sys.databases AS d
            LEFT JOIN msdb.dbo.restorehistory AS rh ON d.name = rh.destination_database_name
        WHERE
            d.name NOT IN ('master', 'tempdb', 'model', 'msdb')
    ) AS subquery
WHERE
    [rn] = 1
ORDER BY
    [database_name] ASC;
    `);

    const databases = result.recordset.map((db) => ({
      name: db.database_name,
      createDate: moment(db.create_date).format('YYYY-MM-DD HH:mm'),
      lastRestoreDate: moment(db.last_restore_date).format('YYYY-MM-DD HH:mm'),
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
  const { sourceServer, sourceDatabaseName } = req.body;
  
  if (!sourceServer || (sourceServer !== 'server1' && sourceServer !== 'server2')) {
    return res.status(400).json({ error: 'Debe proporcionar un valor válido para el parámetro "sourceServer" (server1 o server2)' });
  }

  try {
    const config = sourceServer === 'server2' ? SQLServer2Config : SQLServer1Config;
    const pool = await sql.connect(config);

    // Verificar si la base de datos existe y obtener su estado
    const dbStatusResult = await pool
      .request()
      .query(`
        SELECT state_desc
        FROM sys.databases
        WHERE name = '${sourceDatabaseName}'
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
    const backupFileName = `${sourceDatabaseName}_${backupDate}.bak`;

    // Construir la consulta de backup con los parámetros adicionales
    const backupQuery = `
      BACKUP DATABASE [${sourceDatabaseName}] TO DISK='${BackupDestinationPath}\\${backupFileName}' WITH COPY_ONLY, NOINIT
    `;
    await pool.request().query(backupQuery);

    res.json({ message: `OK, Backupeado en ${BackupDestinationPath}\\${backupFileName}` });
  } catch (error) {
    console.error('Error al realizar el backup de la base de datos:', error);
    res.status(500).json({ error: 'Ocurrió un error al realizar el backup de la base de datos' });
  } finally {
    sql.close();
  }
});



app.post('/api/db-restore', async (req, res) => {
  const { destinationDatabaseName, bakfileLocation, overwrite } = req.body;

  if (!destinationDatabaseName || !bakfileLocation) {
    return res.status(400).json({ error: 'Debe proporcionar los parámetros "destinationDatabaseName" y "bakfileLocation"' });
  }

  // Convert overwrite to boolean if it's a string
  const overwriteValue = overwrite === 'true' ? true : overwrite;

  try {
    const pool = await sql.connect(SQLServer1Config);

    // Verificar si la base de datos existe
    const dbExistsResult = await pool
      .request()
      .query(`
        SELECT COUNT(*) AS dbCount
        FROM sys.databases
        WHERE name = '${destinationDatabaseName}'
      `);

    const dbCount = dbExistsResult.recordset[0].dbCount;

    if (dbCount > 0 && overwriteValue !== true) {
      return res.status(400).json({ error: 'La base de datos ya existe. La restauración no puede continuar.' });
    }

    // Verificar si la base de datos está en medio de una restauración
    const dbRestoreStatusResult = await pool
      .request()
      .query(`
        SELECT COUNT(*) AS restoreCount
        FROM sys.dm_exec_requests
        WHERE database_id = DB_ID('${destinationDatabaseName}') AND command = 'RESTORE DATABASE'
      `);

    const restoreCount = dbRestoreStatusResult.recordset[0].restoreCount;

    if (restoreCount > 0) {
      return res.status(400).json({ error: 'La base de datos está en medio de un proceso de restauración. La restauración no puede continuar.' });
    }

    // Restaurar la base de datos
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

    const newDataLogicalName = `${destinationDatabaseName}`;
    const newLogLogicalName = `${destinationDatabaseName}_Log`;

    const restoreQuery = `
      RESTORE DATABASE [${destinationDatabaseName}]
      FROM DISK = '${bakfileLocation}'
      WITH
      MOVE '${dataFile.LogicalName}' TO '${MDFLocation}\\${destinationDatabaseName}.mdf',
      MOVE '${logFile.LogicalName}' TO '${LDFLocation}\\${destinationDatabaseName}_log.ldf',
      REPLACE,
      RECOVERY
    `;
    await pool.request().query(restoreQuery);

    const renameDataLogicalNameQuery = `
      ALTER DATABASE [${destinationDatabaseName}] MODIFY FILE (NAME = '${dataFile.LogicalName}', NEWNAME = '${newDataLogicalName}')
    `;
    await pool.request().query(renameDataLogicalNameQuery);

    const renameLogLogicalNameQuery = `
      ALTER DATABASE [${destinationDatabaseName}] MODIFY FILE (NAME = '${logFile.LogicalName}', NEWNAME = '${newLogLogicalName}')
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



const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});