const functions = require('firebase-functions'); // get the Firebase Cloud Function API
const admin = require('firebase-admin'); // get the admin from the Firebase Admin SDK

admin.initializeApp(functions.config().functions); // config for functions (cloud presumably)

var messageData;

// use the onCreate listener to trigger changes when a new doc is created
exports.messageTrigger = functions.firestore.document('messages/{messageId}').onCreate(async (snapshot, context) => {
    if(snapshot.empty) {
        console.error('No devices found/message data is null!');
        return;
    }

    messageData = snapshot.data(); // get the doc snapshot's data (like in Flutter)

    const content = messageData.content; // content of sent message
    const toUserId = messageData.toId;

    var toUserDocumentSnapshot = admin.firestore().collection('users').doc(toUserId).get().then((doc) => {
        if(doc.exists) {
            return doc;  
        }
        // TODO: Delete messages of deleted users in the future in order to not go in this handler
        console.error('Cannot find user to send the notification to! Their data is null or they do not exist!'); 
        return null;  
    });

    if(toUserDocumentSnapshot === null) { // return if doc is null
        return;
    }

    var toUserData = (await toUserDocumentSnapshot).data();

    var payload = { // payload to send as a notification in the specific format required
        notification: { title: 'New message from ' + toUserData.username + '!', 
            body: content ? 
                (content <= 100 ? content : (content.substring(0, 97) + '...')) 
                : '', 
            sound: 'default' 
        },
        data: { click_action: 'FLUTTER_NOTIFICATION_CLICK', message: 'You\'ve received a new message!' },
    }

    var toUserDeviceTokens = toUserData.deviceTokens; // get the user's original device tokens where he's logged in

    if(toUserDeviceTokens.length === 0) {
        // null/empty array (user logged out from all devices); return
        return;
    }

    var tokenMergeResult = admin.messaging().sendToDevice(toUserDeviceTokens, payload).then(async response => {
        // check the response of the notification sending to all tokens here and validate them
        // removing the invalid ones from the document of the toId user from Firestore
        response.results.forEach((result, index) => { // cleanup the invalid tokens here
            const error = result.error; // get whether there was an error w/ the token sending
            if(error) {
                console.error('Failure sending notification to ', toUserDeviceTokens[index], error);
                // we know there's an error, which means we have to remove it from the tokens array
                if(error.code === 'messaging/invalid-registration-token' ||
                    error.code === 'messaging/registration-token-not-registered') {
                    toUserDeviceTokens.splice(index, 1); // remove the token at the index
                }
            }
        });

        return admin.firestore().collection('users')
            .doc(toUserId)
            .update({ deviceTokens: toUserDeviceTokens }).then(res => res); // overwrite the token array with the modified device token array
    });
});

// // Create and Deploy Your First Cloud Functions
// // https://firebase.google.com/docs/functions/write-firebase-functions
//
// exports.helloWorld = functions.https.onRequest((request, response) => {
//  response.send("Hello from Firebase!");
// });
