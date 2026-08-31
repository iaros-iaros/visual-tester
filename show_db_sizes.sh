#!/bin/bash
sudo docker exec postgres-visual-tester psql -U n8n -d n8n -c "
SELECT 
    table_name, 
    pg_size_pretty(pg_total_relation_size(quote_ident(table_name))) AS total_size
FROM information_schema.tables 
WHERE table_schema = 'public' 
ORDER BY pg_total_relation_size(quote_ident(table_name)) DESC 
LIMIT 5;"
