import request from 'supertest';
// Import your app instance here

describe('GET /impact/:ngoId (#57)', () => {
  it('correctly calculates platformSharePercent across multiple NGOs using SQL aggregation', async () => {
    // Seed test streams for NGO A and NGO B with known balances and withdrawals
    
    const response = await request(app).get('/impact/ngo_test_1');
    
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('platformSharePercent');
    // Assert expected percentage calculation against the SQL-aggregated platform total
  });
});