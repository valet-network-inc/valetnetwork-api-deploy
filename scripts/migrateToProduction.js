const { MongoClient } = require('mongodb');

// MongoDB connection string
const MONGO_URI = process.env.MONGO_URI; // was hardcoded in plaintext — now env-only

async function migrateCollections() {
    let client;
    
    try {
        // Connect to MongoDB
        console.log('Connecting to MongoDB...');
        client = new MongoClient(MONGO_URI);
        await client.connect();
        console.log('Connected to MongoDB');
        
        // Get database references
        const testDb = client.db('test');
        const productionDb = client.db('production');
        
        // Collections to migrate
        const collections = ['locations', 'events'];
        
        for (const collectionName of collections) {
            console.log(`\nMigrating ${collectionName} collection...`);
            
            // Get the collections
            const testCollection = testDb.collection(collectionName);
            const productionCollection = productionDb.collection(collectionName);
            
            // Count documents in test collection
            const testCount = await testCollection.countDocuments();
            console.log(`Found ${testCount} documents in test.${collectionName}`);
            
            if (testCount === 0) {
                console.log(`No documents to migrate in ${collectionName}`);
                continue;
            }
            
            // Check if production collection already has data
            const productionCount = await productionCollection.countDocuments();
            if (productionCount > 0) {
                console.log(`Warning: production.${collectionName} already contains ${productionCount} documents`);
                console.log('Clearing existing documents in production collection...');
                await productionCollection.deleteMany({});
            }
            
            // Fetch all documents from test collection
            const documents = await testCollection.find({}).toArray();
            
            // Insert documents into production collection
            console.log(`Inserting ${documents.length} documents into production.${collectionName}...`);
            const result = await productionCollection.insertMany(documents);
            console.log(`Successfully inserted ${result.insertedCount} documents into production.${collectionName}`);
        }
        
        console.log('\nMigration completed successfully!');
        
    } catch (error) {
        console.error('Migration failed:', error);
        process.exit(1);
    } finally {
        // Close connection
        if (client) {
            await client.close();
            console.log('Closed MongoDB connection');
        }
        process.exit(0);
    }
}

// Run the migration
console.log('Starting migration from test to production database...');
migrateCollections();