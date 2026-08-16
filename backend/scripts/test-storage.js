const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

async function testStorage() {
  console.log('Testing Supabase Storage Bucket ("eduverse-uploads")...');
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  const bucketName = process.env.SUPABASE_STORAGE_BUCKET || 'eduverse-uploads';

  if (!url || !key) {
    console.error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing');
    process.exit(1);
  }

  const supabase = createClient(url, key);

  try {
    const { data: buckets, error: bErr } = await supabase.storage.listBuckets();
    if (bErr) {
      console.error('Failed to list buckets:', bErr.message);
    } else {
      console.log('Buckets found in Supabase Storage:', buckets.map(b => `${b.name} (public: ${b.public})`));
    }

    const { data: bucket, error: bucketError } = await supabase.storage.getBucket(bucketName);
    if (bucketError) {
      console.log(`Bucket "${bucketName}" not found. Creating public bucket...`);
      const { data: newBucket, error: createError } = await supabase.storage.createBucket(bucketName, {
        public: true,
      });
      if (createError) {
        console.error('Failed to create bucket:', createError.message);
      } else {
        console.log(`Successfully created bucket "${bucketName}"!`);
      }
    } else {
      console.log(`Bucket "${bucketName}" exists and is accessible!`);
    }

    // Test file upload
    const testBuffer = Buffer.from('Eduverse Supabase Storage Test Content');
    const testKey = `test-${Date.now()}.txt`;
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from(bucketName)
      .upload(testKey, testBuffer, { contentType: 'text/plain', upsert: true });

    if (uploadError) {
      console.error('Upload test failed:', uploadError.message);
    } else {
      const { data: publicUrlData } = supabase.storage.from(bucketName).getPublicUrl(testKey);
      console.log('✓ File upload successful!');
      console.log('  Key:', testKey);
      console.log('  Public CDN URL:', publicUrlData.publicUrl);

      // Clean up test file
      await supabase.storage.from(bucketName).remove([testKey]);
      console.log('  Cleaned up test file.');
    }
  } catch (err) {
    console.error('Storage test failed:', err.message);
  }
}

testStorage();
