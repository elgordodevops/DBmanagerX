$(document).ready(function () {
  const server1TableBody = $('#server1TableBody');
  const server2TableBody = $('#server2TableBody');
  const backupRestoreButton = $('#backupRestoreButton');
  const API_URL = 'http://192.168.0.120:3000/api'; 

  let sourceDatabase = '';
  let sourceServer = '';
  let destinationDatabase = '';

  function loadDatabaseList(serverElement, server) {
    $.ajax({
      url: `${API_URL}/db-list`,
      method: 'POST',
      contentType: 'application/json',
      data: JSON.stringify({ server }),
      success: function (data) {
        serverElement.empty(); // Clear previous data
        data.forEach(database => {
          const row = `
            <tr>
              <td><input type="radio" name="${server}DatabaseSelect" value="${database.name}" data-server="${server}"></td>
              <td>${database.name}</td>
              <td>${database.createDate}</td>
              <td>${database.lastRestoreDate}</td>
              <td>${database.state}</td>
            </tr>
          `;
          serverElement.append(row);
        });
      }
    });
  }

  loadDatabaseList(server1TableBody, 'server1');
  loadDatabaseList(server2TableBody, 'server2');

  $('body').on('change', 'input[name="server1DatabaseSelect"]', function () {
    sourceDatabase = $(this).val();
    sourceServer = 'server1';
  });

  $('body').on('change', 'input[name="server2DatabaseSelect"]', function () {
    destinationDatabase = $(this).val();
  });

  $('#server1Search').keyup(function () {
    const searchTerm = $(this).val().toLowerCase();
    const filteredDatabases = server1TableBody.find('tr').filter(function () {
      const name = $(this).find('td:nth-child(2)').text().toLowerCase();
      return name.includes(searchTerm);
    });
    server1TableBody.find('tr').hide();
    filteredDatabases.show();
  });

  $('#server2Search').keyup(function () {
    const searchTerm = $(this).val().toLowerCase();
    const filteredDatabases = server2TableBody.find('tr').filter(function () {
      const name = $(this).find('td:nth-child(2)').text().toLowerCase();
      return name.includes(searchTerm);
    });
    server2TableBody.find('tr').hide();
    filteredDatabases.show();
  });

  $('#backupRestoreButton').click(function () {
    const summary = `
      <div style="text-align: left;">
        <ul>
          <li><strong>SourceServer:</strong> ${sourceServer}</li>
          <li><strong>SourceDatabase:</strong> ${sourceDatabase}</li>
          <br>
          <li><strong>DestinationServer:</strong> server2</li>
          <li><strong>DestinationDatabase:</strong> <input id="destinationDatabaseInput" class="swal2-input" placeholder="Destination Database" value="${destinationDatabase}"></li>
        </ul>
      </div>
    `;  
    Swal.fire({
      title: 'Backup-Restore',
      html: summary,
      icon: 'question',
      showCancelButton: true,
      confirmButtonText: 'Yes, proceed!',
      cancelButtonText: 'No, cancel',
      reverseButtons: true,
      preConfirm: () => {
        destinationDatabase = $('#destinationDatabaseInput').val();
      }
    }).then((result) => {
      if (result.isConfirmed) {
        $.ajax({
          url: `${API_URL}/db-backup-restore`,
          method: 'POST',
          contentType: 'application/json',
          data: JSON.stringify({
            sourceServer,
            sourceDatabaseName: sourceDatabase,
            destinationDatabaseName: destinationDatabase,
            overwrite: true,
          }),
          success: function () {
            Swal.fire('Success', 'Backup-Restore completed successfully!', 'success');
            loadDatabaseList(server1TableBody, 'server1');
            loadDatabaseList(server2TableBody, 'server2');
          },
          error: function () {
            Swal.fire('Error', 'Backup and Restore failed.', 'error');
          }
        });
      } else {
        Swal.fire('Warning', 'Please select databases for both servers.', 'warning');
      }
    });
  });
  
});