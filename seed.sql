-- Run AFTER creating 4 users in Supabase Auth (Dashboard > Authentication). Replace the UUIDs below.
insert into profiles (id,role,name,address,verified,capacity) values
 ('<DONOR_UUID>','donor','Saffron Kitchen','12 Market St',false,null),
 ('<NGO_UUID>','ngo','Hope Home Orphanage','4 Elm Road',true,80),
 ('<VOL_UUID>','volunteer','Ravi Kumar',null,false,null),
 ('<ADMIN_UUID>','admin','Platform Admin',null,false,null);
insert into donations (donor_id,name,food_type,servings,weight_kg,prepared_at,expires_at,storage_info,allergens,pickup_address) values
 ('<DONOR_UUID>','Vegetable biryani','Veg',40,16,now()-interval '2 hours',now()+interval '4 hours','Covered trays, held above 60C','None declared','12 Market St'),
 ('<DONOR_UUID>','Assorted pastries','Veg',30,null,now()-interval '1 hour',now()+interval '6 hours','Boxed, room temperature','Nuts, dairy','3 Mill Rd');
