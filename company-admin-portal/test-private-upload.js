const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

// Read credentials from .env file
const envContent = fs.readFileSync('/root/company-admin-portal/.env', 'utf8');
const tokenMatch = envContent.match(/IAGON_ACCESS_TOKEN=(.+)/);
const nodeMatch = envContent.match(/IAGON_NODE_ID=(.+)/);

const token = tokenMatch ? tokenMatch[1].trim() : null;
const nodeId = nodeMatch ? nodeMatch[1].trim() : null;

console.log('Token found:', !!token);
console.log('Node ID:', nodeId);
console.log('');

(async () => {
  // Test different visibility parameters
  const testCases = [
    { field: 'visibility', value: 'private' },
    { field: 'is_private', value: 'true' },
    { field: 'is_public', value: 'false' },
    { field: 'public', value: 'false' },
    { field: 'private', value: 'true' }
  ];

  for (const testCase of testCases) {
    console.log('=== Testing field: ' + testCase.field + '=' + testCase.value + ' ===');

    const testContent = Buffer.from('PRIVATE TEST - ' + new Date().toISOString());
    const filename = 'private-' + testCase.field + '-' + Date.now() + '.txt';

    const formData = new FormData();
    formData.append('file', testContent, {
      filename: filename,
      contentType: 'text/plain'
    });
    formData.append('node_id', nodeId);
    formData.append(testCase.field, testCase.value);

    try {
      const response = await axios.post('https://gw.iagon.com/api/v2/storage/upload', formData, {
        headers: {
          ...formData.getHeaders(),
          'x-api-key': token
        },
        timeout: 60000
      });

      console.log('  Status:', response.status);
      console.log('  File ID:', response.data.data?._id);
      console.log('  Success:', response.data.success);
    } catch (error) {
      console.log('  Error:', error.message);
      if (error.response) {
        console.log('  Response Status:', error.response.status);
      }
    }
    console.log('');
  }

  // Wait a moment then check private storage
  console.log('Waiting 3 seconds...');
  await new Promise(r => setTimeout(r, 3000));

  // Now check if any files appeared in private storage
  console.log('\n=== Checking Private Storage ===');
  const privateRes = await axios.get('https://gw.iagon.com/api/v2/storage/directory?visibility=private', {
    headers: { 'x-api-key': token }
  });

  console.log('Private files count:', privateRes.data.data?.files?.length || 0);
  if (privateRes.data.data?.files) {
    privateRes.data.data.files.forEach(f => {
      console.log('  -', f.name, '(' + f._id + ')');
    });
  }

  console.log('\n=== Checking Public Storage (last 5 files) ===');
  const publicRes = await axios.get('https://gw.iagon.com/api/v2/storage/directory?visibility=public', {
    headers: { 'x-api-key': token }
  });

  console.log('Public files count:', publicRes.data.data?.files?.length || 0);
  const publicFiles = publicRes.data.data?.files || [];
  publicFiles.slice(-5).forEach(f => {
    console.log('  -', f.name, '(' + f._id + ')');
  });
})();
