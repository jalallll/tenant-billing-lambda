const { createClient } = require('@supabase/supabase-js');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); // Stripe API key

// Set up Supabase client with environment variables
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_API_KEY);

exports.handler = async (event) => {
    console.log("Running tenant billing job...");

    try {
        // Step 1: Fetch tenants from Supabase who have a rent, move in date, and move out date
        const { data: tenants, error } = await supabase
            .from("tenants")
            .select("*")
            .is("rent", null, false)
            .is("move_in_date", null, false)
            .is("move_out_date", null, false);

        if (error) {
            throw new Error("Error fetching tenants: " + error.message);
        }

        const today = new Date();

        // Step 2: Loop through tenants and process payments
        for (const tenant of tenants) {
            const moveInDate = new Date(tenant.move_in_date);
            const lastPaymentDate = tenant.rent_most_recent_payment_date
                ? new Date(tenant.rent_most_recent_payment_date)
                : null;

            // Logic to check if tenant needs to be charged today
            if (shouldChargeTenant(today, moveInDate, lastPaymentDate, tenant.move_out_date)) {
                const amount = tenant.rent;  // Rent amount

                const { data: paymentMethods, error } = await supabase
                    .from('stripe_payment_methods')
                    .select('*')
                    .eq('tenant_id', tenant.id); // Match tenant_id with tenant.id

                if (error) {
                    console.error('Error fetching payment methods:', error);
                } else {
                    console.log('Payment methods for tenant:', paymentMethods);
                }

                if (paymentMethods.length > 0) {
                    const stripe_customer_id = paymentMethods[0].stripe_customer_id
                    const stripe_payment_method_id = paymentMethods[0].stripe_payment_method_id

                    // Step 3: Charge the tenant via Stripe
                    await stripe.paymentIntents.create({
                        amount: amount * 100,  // The rent amount in cents
                        currency: "cad",
                        customer: tenant.stripe_customer_id,
                        payment_method: tenant.stripe_payment_method_id,
                        confirm: true,
                    });

                    // Step 4: Update the tenant's most recent payment date in Supabase
                    await supabase
                        .from("tenants")
                        .update({ rent_most_recent_payment_date: today.toISOString() })
                        .eq("id", tenant.id);
                }

            }
        }

        return {
            statusCode: 200,
            body: JSON.stringify({ message: "Tenant billing completed successfully." }),
        };
    } catch (error) {
        console.error("Error during billing:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ message: "Error during billing.", error: error.message }),
        };
    }
};

// Helper function to determine if rent should be charged
function shouldChargeTenant(today, moveInDate, lastPaymentDate, moveOutDate) {
    let numberOfUnpaidDays = 0

    if(lastPaymentDate){
        numberOfUnpaidDays = (today - lastPaymentDate) / (1000 * 60 * 60 * 24) // math to convert miliseconds to days
    }
    numberOfUnpaidDays = (today - moveInDate) / (1000 * 60 * 60 * 24)

    // Ensure no more payments after move-out
    if (moveOutDate && today >= new Date(moveOutDate)) return false;

    return numberOfUnpaidDays >= 30;
}
